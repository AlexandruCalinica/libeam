// src/supervisor.ts

import { ActorRef } from './actor';
import { ActorSystem } from './actor_system';

export type SupervisionStrategy = 'Restart' | 'Stop';

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
  private readonly restartCounts = new Map<string, { count: number; timestamp: number }>();

  constructor(private readonly system: ActorSystem, private readonly options: SupervisionOptions) {}

  handleCrash(actorRef: ActorRef, error: any): void {
    const actorId = actorRef.id.id;
    console.error(`Actor ${actorId} crashed with error:`, error);

    const now = Date.now();
    const record = this.restartCounts.get(actorId) || { count: 0, timestamp: now };

    if (now - record.timestamp > this.options.periodMs) {
      // Reset the count if the period has passed
      record.count = 0;
      record.timestamp = now;
    }

    if (record.count >= this.options.maxRestarts) {
      console.log(`Actor ${actorId} has crashed too many times. Stopping.`);
      this.system.stop(actorRef);
      this.restartCounts.delete(actorId);
      return;
    }

    record.count++;
    this.restartCounts.set(actorId, record);

    switch (this.options.strategy) {
      case 'Restart':
        console.log(`Restarting actor ${actorId}`);
        // This is a simplification. A real implementation needs to re-create
        // the actor with its original arguments. We'll add that later.
        this.system.stop(actorRef).then(() => {
          console.error("Supervisor can't restart actors yet. Stopping instead.");
          // this.system.spawn(...)
        });
        break;
      case 'Stop':
        console.log(`Stopping actor ${actorId}`);
        this.system.stop(actorRef);
        break;
    }
  }
}
