// src/gossip_registry.ts

import { Registry } from './registry';
import { RegistryGossip } from './registry_gossip';

/**
 * A Registry implementation backed by RegistryGossip.
 *
 * This adapter allows the gossip-based registry to be used anywhere
 * the Registry interface is expected (e.g., in ActorSystem).
 */
export class GossipRegistry implements Registry {
  constructor(private gossip: RegistryGossip) {}

  async register(name: string, nodeId: string): Promise<void> {
    // Use current timestamp as generation for actor lifecycle tracking
    this.gossip.register(name, nodeId, Date.now());
  }

  async unregister(name: string): Promise<void> {
    this.gossip.unregister(name);
  }

  async lookup(name: string): Promise<string | null> {
    return this.gossip.lookup(name);
  }

  async getNodeActors(nodeId: string): Promise<string[]> {
    return this.gossip.getNodeActors(nodeId);
  }

  async connect(): Promise<void> {
    // Connection is handled by the RegistryGossip and Transport layers
  }

  async disconnect(): Promise<void> {
    // Disconnection is handled by the RegistryGossip and Transport layers
  }
}
