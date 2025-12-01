// src/supervisor.ts

import { ActorRef, TerminationReason } from "./actor";
import { ActorSystem } from "./actor_system";
import { Logger, createLogger } from "./logger";

export type SupervisionStrategy = "Restart" | "Stop";

export interface SupervisionOptions {
  strategy: SupervisionStrategy;
  maxRestarts: number;
  periodMs: number;
}

/**
 * A basic supervisor that handles actor crashes.
 * For now, it's a simple one-for-one strategy.
 */
export class Supervisor {
  private readonly restartCounts = new Map<
    string,
    { count: number; timestamp: number }
  >();
  private readonly log: Logger;

  constructor(
    private readonly system: ActorSystem,
    private readonly options: SupervisionOptions,
  ) {
    this.log = createLogger("Supervisor", system.id);
  }

  handleCrash(actorRef: ActorRef, error: any): void {
    const actorId = actorRef.id.id;

    // Check if this is a child actor - delegate to child supervisor
    const metadata = this.system.getActorMetadata(actorId);
    if (metadata?.parent) {
      this.system
        .getChildSupervisor()
        .handleChildCrash(actorRef, error)
        .catch((err) => {
          this.log.error("Error in child supervision", err, { actorId });
        });
      return;
    }

    // Handle root actor crashes
    this.log.error(
      "Actor crashed",
      error instanceof Error ? error : new Error(String(error)),
      { actorId },
    );

    const now = Date.now();
    const record = this.restartCounts.get(actorId) || {
      count: 0,
      timestamp: now,
    };

    if (now - record.timestamp > this.options.periodMs) {
      // Reset the count if the period has passed
      record.count = 0;
      record.timestamp = now;
    }

    if (record.count >= this.options.maxRestarts) {
      this.log.warn("Actor exceeded max restarts, stopping", {
        actorId,
        maxRestarts: this.options.maxRestarts,
      });
      // Notify watchers that actor is being killed due to max restarts
      this.system.notifyWatchers(actorRef, { type: "killed" });
      this.system.stop(actorRef);
      this.restartCounts.delete(actorId);
      return;
    }

    record.count++;
    this.restartCounts.set(actorId, record);

    switch (this.options.strategy) {
      case "Restart":
        this.log.info("Restarting actor", { actorId, attempt: record.count });
        this.system
          .restart(actorRef)
          .then((newRef) => {
            if (newRef) {
              this.log.info("Actor restarted successfully", {
                actorId,
                newActorId: newRef.id.id,
              });
            } else {
              this.log.error("Failed to restart actor", undefined, { actorId });
            }
          })
          .catch((err) => {
            this.log.error("Error restarting actor", err, { actorId });
          });
        break;
      case "Stop":
        this.log.info("Stopping actor", { actorId });
        // Notify watchers with the error reason
        this.system.notifyWatchers(actorRef, { type: "error", error });
        this.system.stop(actorRef);
        break;
    }
  }
}
