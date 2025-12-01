// src/child_supervisor.ts

import { Actor, ActorRef, ChildSupervisionOptions } from "./actor";
import { ActorSystem } from "./actor_system";
import { Logger, createLogger } from "./logger";

interface RestartRecord {
  count: number;
  timestamp: number;
}

/**
 * Handles supervision of child actors within a supervision tree.
 * Implements one-for-one, one-for-all, and rest-for-one strategies.
 */
export class ChildSupervisor {
  // Track restarts by parent + child name/spawn-key to survive across restarts
  private readonly restartCounts = new Map<string, RestartRecord>();
  private readonly log: Logger;

  constructor(private readonly system: ActorSystem) {
    this.log = createLogger("ChildSupervisor", system.id);
  }

  /**
   * Generates a stable key for tracking restarts.
   * Uses parent ID + child name or original spawn args as identifier.
   */
  private getRestartKey(childId: string, parentId: string): string {
    const metadata = this.system.getActorMetadata(childId);
    // Use name if available, otherwise use stringified args
    const childKey =
      metadata?.options.name ||
      JSON.stringify(metadata?.options.args || childId);
    return `${parentId}:${childKey}`;
  }

  /**
   * Handles a child actor crash according to the parent's supervision strategy.
   * @param childRef The crashed child actor
   * @param error The error that caused the crash
   */
  async handleChildCrash(childRef: ActorRef, error: any): Promise<void> {
    const childId = childRef.id.id;
    const metadata = this.system.getActorMetadata(childId);

    if (!metadata?.parent) {
      // Not a child actor, delegate to regular supervisor
      this.log.debug("Not a child actor, skipping child supervision", {
        actorId: childId,
      });
      return;
    }

    const parentActor = this.system.getActor(metadata.parent.id.id);
    if (!parentActor) {
      this.log.warn("Parent actor not found for crashed child", {
        childId,
        parentId: metadata.parent.id.id,
      });
      return;
    }

    // Get parent's supervision options
    const options = parentActor.childSupervision();

    this.log.error(
      "Child actor crashed",
      error instanceof Error ? error : new Error(String(error)),
      { childId, parentId: metadata.parent.id.id, strategy: options.strategy },
    );

    // Check restart limits using stable key
    const restartKey = this.getRestartKey(childId, metadata.parent.id.id);
    if (!this.canRestart(restartKey, options)) {
      this.log.warn("Child exceeded max restarts, stopping", {
        childId,
        maxRestarts: options.maxRestarts,
      });
      // Notify watchers that actor is being killed due to max restarts
      this.system.notifyWatchers(childRef, { type: "killed" });
      await this.system.stop(childRef);
      return;
    }

    // Apply supervision strategy
    switch (options.strategy) {
      case "one-for-one":
        await this.handleOneForOne(childRef, parentActor);
        break;
      case "one-for-all":
        await this.handleOneForAll(childRef, parentActor);
        break;
      case "rest-for-one":
        await this.handleRestForOne(childRef, parentActor);
        break;
    }
  }

  /**
   * Checks if an actor can be restarted based on restart limits.
   * @param restartKey Stable key for tracking restarts across actor ID changes
   */
  private canRestart(
    restartKey: string,
    options: ChildSupervisionOptions,
  ): boolean {
    const now = Date.now();
    const record = this.restartCounts.get(restartKey) || {
      count: 0,
      timestamp: now,
    };

    // Reset count if period has passed
    if (now - record.timestamp > options.periodMs) {
      record.count = 0;
      record.timestamp = now;
    }

    if (record.count >= options.maxRestarts) {
      return false;
    }

    record.count++;
    this.restartCounts.set(restartKey, record);
    return true;
  }

  /**
   * One-for-one: Only restart the crashed child.
   */
  private async handleOneForOne(
    childRef: ActorRef,
    _parentActor: Actor,
  ): Promise<void> {
    this.log.info("Applying one-for-one strategy", {
      childId: childRef.id.id,
    });

    const newRef = await this.system.restart(childRef);
    if (newRef) {
      this.log.info("Child restarted successfully", {
        oldId: childRef.id.id,
        newId: newRef.id.id,
      });
    } else {
      this.log.error("Failed to restart child", undefined, {
        childId: childRef.id.id,
      });
    }
  }

  /**
   * One-for-all: Restart all children if one crashes.
   */
  private async handleOneForAll(
    crashedRef: ActorRef,
    parentActor: Actor,
  ): Promise<void> {
    this.log.info("Applying one-for-all strategy", {
      crashedChildId: crashedRef.id.id,
      totalChildren: parentActor.context.children.size,
    });

    // Get all children (copy to avoid modification during iteration)
    const allChildren = Array.from(parentActor.context.childOrder);

    // Collect metadata BEFORE stopping (stopping deletes metadata)
    const metadataList = allChildren.map((ref) => ({
      ref,
      metadata: this.system.getActorMetadata(ref.id.id),
    }));

    // Stop all children first (in reverse order)
    for (let i = allChildren.length - 1; i >= 0; i--) {
      const childRef = allChildren[i];
      await this.system.stop(childRef);
    }

    // Restart all children (in original order)
    for (const { ref, metadata } of metadataList) {
      if (metadata) {
        const newRef = this.system.spawnChild(
          parentActor.self,
          metadata.actorClass,
          metadata.options,
        );
        this.log.debug("Restarted child in one-for-all", {
          oldId: ref.id.id,
          newId: newRef.id.id,
        });
      }
    }

    this.log.info("All children restarted", {
      count: allChildren.length,
    });
  }

  /**
   * Rest-for-one: Restart the crashed child and all children started after it.
   */
  private async handleRestForOne(
    crashedRef: ActorRef,
    parentActor: Actor,
  ): Promise<void> {
    const childOrder = parentActor.context.childOrder;
    const crashedIndex = childOrder.findIndex(
      (ref) => ref.id.id === crashedRef.id.id,
    );

    if (crashedIndex === -1) {
      this.log.warn("Crashed child not found in order list", {
        childId: crashedRef.id.id,
      });
      return;
    }

    // Get children to restart (crashed child and all after it)
    const childrenToRestart = childOrder.slice(crashedIndex);

    this.log.info("Applying rest-for-one strategy", {
      crashedChildId: crashedRef.id.id,
      crashedIndex,
      childrenToRestart: childrenToRestart.length,
    });

    // Collect metadata before stopping
    const metadataList = childrenToRestart.map((ref) => ({
      ref,
      metadata: this.system.getActorMetadata(ref.id.id),
    }));

    // Stop children in reverse order (newest first)
    for (let i = childrenToRestart.length - 1; i >= 0; i--) {
      await this.system.stop(childrenToRestart[i]);
    }

    // Restart in original order
    for (const { ref, metadata } of metadataList) {
      if (metadata) {
        const newRef = this.system.spawnChild(
          parentActor.self,
          metadata.actorClass,
          metadata.options,
        );
        this.log.debug("Restarted child in rest-for-one", {
          oldId: ref.id.id,
          newId: newRef.id.id,
        });
      }
    }

    this.log.info("Rest-for-one restart complete", {
      restartedCount: childrenToRestart.length,
    });
  }

  /**
   * Clears restart count for an actor (e.g., when manually stopped).
   */
  clearRestartCount(actorId: string): void {
    this.restartCounts.delete(actorId);
  }
}
