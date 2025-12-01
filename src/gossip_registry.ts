// src/gossip_registry.ts

import { Registry, ActorLocation } from "./registry";
import { RegistryGossip } from "./registry_gossip";

/**
 * A Registry implementation backed by RegistryGossip.
 *
 * This adapter allows the gossip-based registry to be used anywhere
 * the Registry interface is expected (e.g., in ActorSystem).
 *
 * Note: RegistryGossip now implements Registry directly, so this adapter
 * is primarily for backwards compatibility or if you need to wrap
 * an existing RegistryGossip instance.
 */
export class GossipRegistry implements Registry {
  constructor(private gossip: RegistryGossip) {}

  async register(name: string, nodeId: string, actorId: string): Promise<void> {
    return this.gossip.register(name, nodeId, actorId);
  }

  async unregister(name: string): Promise<void> {
    return this.gossip.unregister(name);
  }

  async lookup(name: string): Promise<ActorLocation | null> {
    return this.gossip.lookup(name);
  }

  async getNodeActors(nodeId: string): Promise<string[]> {
    return this.gossip.getNodeActors(nodeId);
  }

  async connect(): Promise<void> {
    return this.gossip.connect();
  }

  async disconnect(): Promise<void> {
    return this.gossip.disconnect();
  }
}
