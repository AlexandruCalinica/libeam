// src/dynamic_supervisor.ts
//
// DynamicSupervisor: On-demand supervised child spawning.
// Wraps an internal actor with startChild/terminateChild/whichChildren/countChildren.
// Follows the Agent pattern: internal actor + public typed wrapper class.

import {
  Actor,
  ActorRef,
  ChildSupervisionOptions,
} from "./actor";
import { ActorSystem, SpawnOptions } from "./actor_system";
import { MaxChildrenError } from "./errors";
import type {
  ActorDefinition,
  TypedActorRef,
} from "./types/functional";

// ============ Configuration ============

/**
 * Configuration options for a DynamicSupervisor.
 */
export interface DynamicSupervisorOptions {
  /** Maximum number of children (default: Infinity) */
  maxChildren?: number;
  /** Maximum restarts within period before child is permanently stopped (default: 3) */
  maxRestarts?: number;
  /** Period in ms for counting restarts (default: 5000) */
  periodMs?: number;
}

// ============ Return Types ============

/**
 * Information about a child actor managed by a DynamicSupervisor.
 */
export interface ChildInfo {
  /** Reference to the child actor */
  ref: ActorRef;
  /** Name of the actor class */
  className: string;
  /** Registered name (if any) */
  name?: string;
}

/**
 * Child count statistics for a DynamicSupervisor.
 */
export interface ChildCounts {
  /** Number of child specifications (including restarting children) */
  specs: number;
  /** Number of actively running children */
  active: number;
}

// ============ Internal Messages ============

type DynSupCall =
  | { type: "start_child"; actorClass: any; options?: Omit<SpawnOptions, "strategy" | "role"> }
  | { type: "terminate_child"; ref: ActorRef }
  | { type: "which_children" }
  | { type: "count_children" };

// ============ Internal Actor ============

/**
 * Internal actor that backs a DynamicSupervisor.
 * Manages on-demand child spawning with one-for-one supervision.
 * @internal
 */
class DynamicSupervisorActor extends Actor<never, DynSupCall, any> {
  private maxChildren = Infinity;
  private maxRestarts = 3;
  private periodMs = 5000;

  init(options?: DynamicSupervisorOptions) {
    if (options?.maxChildren !== undefined) this.maxChildren = options.maxChildren;
    if (options?.maxRestarts !== undefined) this.maxRestarts = options.maxRestarts;
    if (options?.periodMs !== undefined) this.periodMs = options.periodMs;
  }

  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "one-for-one",
      maxRestarts: this.maxRestarts,
      periodMs: this.periodMs,
    };
  }

  handleCall(message: DynSupCall): any {
    switch (message.type) {
      case "start_child":
        return this.handleStartChild(message.actorClass, message.options);
      case "terminate_child":
        return this.handleTerminateChild(message.ref);
      case "which_children":
        return this.handleWhichChildren();
      case "count_children":
        return this.handleCountChildren();
    }
  }

  handleCast(_message: never): void {}

  private handleStartChild(
    actorClass: any,
    options?: Omit<SpawnOptions, "strategy" | "role">,
  ): ActorRef {
    if (this.context.children.size >= this.maxChildren) {
      throw new MaxChildrenError(this.maxChildren);
    }

    // Spawn under this supervisor — system manages parent-child relationship,
    // metadata, and restart infrastructure automatically.
    const childRef = this.context.system.spawnChild(
      this.self,
      actorClass,
      options || {},
    );

    return childRef;
  }

  private async handleTerminateChild(ref: ActorRef): Promise<boolean> {
    // Find the child in our children set by ID
    const found = [...this.context.children].find(
      (c) => c.id.id === ref.id.id,
    );
    if (!found) return false;

    await this.stopChild(found);
    return true;
  }

  private handleWhichChildren(): ChildInfo[] {
    const result: ChildInfo[] = [];
    for (const childRef of this.context.children) {
      const metadata = this.context.system.getActorMetadata(childRef.id.id);
      result.push({
        ref: childRef,
        className: metadata?.actorClass?.name || "Unknown",
        name: childRef.id.name,
      });
    }
    return result;
  }

  private handleCountChildren(): ChildCounts {
    // For DynamicSupervisor, specs and active are always equal because
    // context.children is the single source of truth managed by the system.
    // During the brief restart window (stopSingle → spawnChild), the count
    // is momentarily lower, but that's unobservable from within handleCall.
    const count = this.context.children.size;
    return { specs: count, active: count };
  }
}

// ============ Public Wrapper ============

/**
 * DynamicSupervisor provides on-demand supervised child spawning.
 *
 * Unlike static supervision trees where children are defined at init time,
 * a DynamicSupervisor starts with zero children and allows adding them
 * at runtime via `startChild()`. All children are independent and supervised
 * with a one-for-one strategy.
 *
 * Follows the Agent pattern: an internal actor manages state, while this
 * wrapper provides a typed public API.
 *
 * @example
 * ```typescript
 * const dynSup = DynamicSupervisor.start(system, { maxChildren: 10 });
 *
 * // Start children on demand
 * const ref = await dynSup.startChild(WorkerActor, { args: ['job-1'] });
 *
 * // Works with functional actors too (returns TypedActorRef)
 * const counter = await dynSup.startChild(Counter, { args: [0] });
 * await counter.call('get'); // fully typed!
 *
 * // Inspect children
 * const children = await dynSup.whichChildren();
 * const counts = await dynSup.countChildren();
 *
 * // Terminate a specific child
 * await dynSup.terminateChild(ref);
 *
 * // Stop the supervisor (cascades to all children)
 * await dynSup.stop();
 * ```
 */
export class DynamicSupervisor {
  private constructor(
    private readonly actorRef: ActorRef<never, DynSupCall, any>,
    private readonly system: ActorSystem,
  ) {}

  /**
   * Starts a new DynamicSupervisor.
   *
   * @param system The actor system
   * @param options Configuration (maxChildren, restarts, etc.)
   * @param spawnOptions Spawn options for the supervisor itself (name, etc.)
   * @returns A new DynamicSupervisor instance
   *
   * @example
   * ```typescript
   * // Basic
   * const dynSup = DynamicSupervisor.start(system);
   *
   * // With limits
   * const dynSup = DynamicSupervisor.start(system, { maxChildren: 100 });
   *
   * // Named
   * const dynSup = DynamicSupervisor.start(system, {}, { name: 'worker-pool' });
   * ```
   */
  static start(
    system: ActorSystem,
    options?: DynamicSupervisorOptions,
    spawnOptions: SpawnOptions = {},
  ): DynamicSupervisor {
    const ref = system.spawn(DynamicSupervisorActor, {
      ...spawnOptions,
      args: [options],
    }) as ActorRef<never, DynSupCall, any>;
    return new DynamicSupervisor(ref, system);
  }

  /**
   * Dynamically start a child under this supervisor.
   *
   * For functional actors (created with `createActor`), returns a `TypedActorRef`
   * with full type inference for `call` and `cast`.
   *
   * For class-based actors, returns a plain `ActorRef`.
   *
   * @throws {MaxChildrenError} If the supervisor has reached its `maxChildren` limit
   *
   * @example
   * ```typescript
   * // Class-based
   * const ref = await dynSup.startChild(WorkerActor, { args: ['job-1'] });
   *
   * // Functional (typed)
   * const counter = await dynSup.startChild(Counter, { args: [0] });
   * await counter.call('get'); // TypeScript knows return type
   * ```
   */
  startChild<
    TArgs extends any[],
    TCalls extends Record<string, (...args: any[]) => any>,
    TCasts extends Record<string, (...args: any[]) => void>,
  >(
    actorClass: ActorDefinition<TArgs, TCalls, TCasts>,
    options?: Omit<SpawnOptions, "strategy" | "role">,
  ): Promise<TypedActorRef<TCalls, TCasts>>;
  startChild<T extends Actor>(
    actorClass: new () => T,
    options?: Omit<SpawnOptions, "strategy" | "role">,
  ): Promise<ActorRef>;
  startChild(
    actorClass: any,
    options?: Omit<SpawnOptions, "strategy" | "role">,
  ): Promise<ActorRef> {
    return this.actorRef.call({ type: "start_child", actorClass, options });
  }

  /**
   * Terminate a child by ref.
   *
   * @param ref The ActorRef of the child to terminate
   * @returns true if the child was found and stopped, false if not found
   */
  terminateChild(ref: ActorRef): Promise<boolean> {
    return this.actorRef.call({ type: "terminate_child", ref });
  }

  /**
   * List all active children with metadata.
   *
   * @returns Array of ChildInfo objects describing each active child
   */
  whichChildren(): Promise<ChildInfo[]> {
    return this.actorRef.call({ type: "which_children" });
  }

  /**
   * Get child counts.
   *
   * @returns Object with `specs` and `active` counts
   */
  countChildren(): Promise<ChildCounts> {
    return this.actorRef.call({ type: "count_children" });
  }

  /**
   * Stop the supervisor and all its children.
   * Children are terminated first (cascading), then the supervisor itself.
   */
  stop(): Promise<void> {
    return this.system.stop(this.actorRef);
  }

  /**
   * Get the supervisor's own ActorRef.
   * Useful for watching/linking the supervisor itself.
   */
  getRef(): ActorRef {
    return this.actorRef;
  }
}
