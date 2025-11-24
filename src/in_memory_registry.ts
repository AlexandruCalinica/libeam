// src/in_memory_registry.ts

import { Registry } from './registry';

/**
 * An in-memory implementation of the Registry interface.
 * It uses a simple Map to store actor locations.
 */
export class InMemoryRegistry implements Registry {
  private readonly registry = new Map<string, string>();

  async connect(): Promise<void> {
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.registry.clear();
    return Promise.resolve();
  }

  async register(name: string, nodeId: string): Promise<void> {
    this.registry.set(name, nodeId);
  }

  async unregister(name: string): Promise<void> {
    this.registry.delete(name);
  }

  async lookup(name: string): Promise<string | null> {
    return this.registry.get(name) || null;
  }

  async getNodeActors(nodeId: string): Promise<string[]> {
    const actors: string[] = [];
    for (const [name, id] of this.registry.entries()) {
      if (id === nodeId) {
        actors.push(name);
      }
    }
    return actors;
  }
}
