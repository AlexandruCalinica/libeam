// src/in_memory_registry.ts

import { Registry, ActorLocation } from "./registry";

/**
 * An in-memory implementation of the Registry interface.
 * It uses a simple Map to store actor locations.
 */
export class InMemoryRegistry implements Registry {
  private readonly registry = new Map<string, ActorLocation>();

  async connect(): Promise<void> {
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.registry.clear();
    return Promise.resolve();
  }

  async register(name: string, nodeId: string, actorId: string): Promise<void> {
    this.registry.set(name, { nodeId, actorId });
  }

  async unregister(name: string): Promise<void> {
    this.registry.delete(name);
  }

  async lookup(name: string): Promise<ActorLocation | null> {
    return this.registry.get(name) || null;
  }

  async getNodeActors(nodeId: string): Promise<string[]> {
    const actors: string[] = [];
    for (const [name, location] of this.registry.entries()) {
      if (location.nodeId === nodeId) {
        actors.push(name);
      }
    }
    return actors;
  }
}
