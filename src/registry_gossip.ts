// src/registry_gossip.ts

import { EventEmitter } from "events";
import { Transport } from "./transport";
import { CustomGossipCluster } from "./custom_gossip_cluster";
import { VectorClock } from "./vector_clock";
import { Registry, ActorLocation } from "./registry";

export interface ActorRegistration {
  name: string;
  nodeId: string;
  actorId: string;
  generation: number;
  vectorClock: VectorClock;
}

export interface RegistryUpdate {
  type: "register" | "unregister";
  registration: ActorRegistration;
}

/**
 * RegistryGossip manages the distributed actor registry using eventual consistency.
 *
 * It uses:
 * - ZeroMQ PUB/SUB for fast registry update propagation
 * - Vector clocks for conflict resolution
 * - Automatic cleanup when nodes die
 *
 * Events:
 * - 'actor_registered': Emitted when a new actor is registered
 * - 'actor_unregistered': Emitted when an actor is unregistered
 * - 'actor_updated': Emitted when actor registration is updated (moved nodes, etc.)
 */
export class RegistryGossip extends EventEmitter implements Registry {
  private localClock: VectorClock;
  private registrations = new Map<string, ActorRegistration>();

  constructor(
    private nodeId: string,
    private transport: Transport,
    private membership: CustomGossipCluster,
  ) {
    super();
    this.localClock = new VectorClock();

    // Listen to membership changes to update transport peers and cleanup
    membership.on("member_join", this.handlePeerJoin.bind(this));
    membership.on("member_leave", this.handlePeerLeave.bind(this));
  }

  async connect(): Promise<void> {
    // Subscribe to registry updates from all peers
    await this.transport.subscribe(
      "registry:updates",
      this.handleRegistryUpdate.bind(this),
    );

    // Update transport with current peers
    this.syncPeers();
  }

  async disconnect(): Promise<void> {
    // Transport will handle unsubscribing when disconnected
    this.registrations.clear();
  }

  /**
   * Registers an actor name to its location.
   * This updates the local registry and broadcasts to all peers.
   * @param name The name of the actor
   * @param nodeId The ID of the node where the actor resides
   * @param actorId The actor's unique instance ID
   */
  async register(name: string, nodeId: string, actorId: string): Promise<void> {
    this.localClock.increment(this.nodeId);

    const registration: ActorRegistration = {
      name,
      nodeId,
      actorId,
      generation: Date.now(),
      vectorClock: this.localClock.clone(),
    };

    this.registrations.set(name, registration);

    // Publish to all peers
    this.transport.publish("registry:updates", {
      type: "register",
      registration: this.serializeRegistration(registration),
    });

    this.emit("actor_registered", registration);
  }

  /**
   * Unregisters an actor name from the registry.
   * @param name The name of the actor to unregister
   */
  async unregister(name: string): Promise<void> {
    const existing = this.registrations.get(name);
    if (!existing) return;

    this.localClock.increment(this.nodeId);

    const update: RegistryUpdate = {
      type: "unregister",
      registration: {
        ...existing,
        vectorClock: this.localClock.clone(),
      },
    };

    this.registrations.delete(name);
    this.transport.publish("registry:updates", {
      type: "unregister",
      registration: this.serializeRegistration(update.registration),
    });

    this.emit("actor_unregistered", name);
  }

  /**
   * Looks up the location for a given actor name.
   * @param name The name of the actor
   * @returns The actor location, or null if not found
   */
  async lookup(name: string): Promise<ActorLocation | null> {
    const reg = this.registrations.get(name);
    if (!reg) return null;
    return { nodeId: reg.nodeId, actorId: reg.actorId };
  }

  /**
   * Gets all actor names registered to a specific node.
   * @param nodeId The ID of the node
   * @returns An array of actor names
   */
  async getNodeActors(nodeId: string): Promise<string[]> {
    const actors: string[] = [];
    for (const [name, reg] of this.registrations.entries()) {
      if (reg.nodeId === nodeId) {
        actors.push(name);
      }
    }
    return actors;
  }

  /**
   * Gets all registrations (for debugging/testing).
   */
  getAllRegistrations(): Map<string, ActorRegistration> {
    return new Map(this.registrations);
  }

  private handleRegistryUpdate(message: any): void {
    const update: RegistryUpdate = message;
    const registration = this.deserializeRegistration(update.registration);

    if (update.type === "unregister") {
      // Remove from local registry
      const existing = this.registrations.get(registration.name);
      if (existing) {
        // Only remove if the incoming unregister is newer
        const cmp = registration.vectorClock.compare(existing.vectorClock);
        if (cmp === "after" || cmp === "concurrent") {
          this.registrations.delete(registration.name);
          this.localClock.merge(registration.vectorClock);
          this.emit("actor_unregistered", registration.name);
        }
      }
      return;
    }

    const existing = this.registrations.get(registration.name);

    if (!existing) {
      // New actor
      this.registrations.set(registration.name, registration);
      this.localClock.merge(registration.vectorClock);
      this.emit("actor_registered", registration);
      return;
    }

    // Conflict resolution using vector clocks
    const cmp = registration.vectorClock.compare(existing.vectorClock);

    if (cmp === "after") {
      // Incoming is newer
      this.registrations.set(registration.name, registration);
      this.localClock.merge(registration.vectorClock);
      this.emit("actor_updated", registration);
    } else if (cmp === "concurrent") {
      // Tie-breaker: higher generation wins, then higher nodeId
      if (registration.generation > existing.generation) {
        this.registrations.set(registration.name, registration);
        this.localClock.merge(registration.vectorClock);
        this.emit("actor_updated", registration);
      } else if (
        registration.generation === existing.generation &&
        registration.nodeId > existing.nodeId
      ) {
        this.registrations.set(registration.name, registration);
        this.localClock.merge(registration.vectorClock);
        this.emit("actor_updated", registration);
      }
    }
    // If 'before', ignore (we have newer version)
  }

  private handlePeerLeave(nodeId: string): void {
    // Cleanup all actors owned by dead node
    const actorsToRemove: string[] = [];

    for (const [name, reg] of this.registrations.entries()) {
      if (reg.nodeId === nodeId) {
        actorsToRemove.push(name);
      }
    }

    for (const name of actorsToRemove) {
      this.registrations.delete(name);
      this.emit("actor_unregistered", name);
    }

    this.syncPeers();
  }

  private handlePeerJoin(nodeId: string): void {
    this.syncPeers();

    // Anti-entropy: send full state to new peer
    // The new peer will merge with its own state
    for (const reg of this.registrations.values()) {
      this.transport.publish("registry:updates", {
        type: "register",
        registration: this.serializeRegistration(reg),
      });
    }
  }

  private syncPeers(): void {
    const peers = this.membership.getLivePeers();
    const peerList: Array<[string, string]> = peers.map((p) => [
      p.id,
      p.address,
    ]);
    this.transport.updatePeers(peerList);
  }

  private serializeRegistration(reg: ActorRegistration): any {
    return {
      name: reg.name,
      nodeId: reg.nodeId,
      actorId: reg.actorId,
      generation: reg.generation,
      vectorClock: reg.vectorClock.toJSON(),
    };
  }

  private deserializeRegistration(data: any): ActorRegistration {
    return {
      name: data.name,
      nodeId: data.nodeId,
      actorId: data.actorId,
      generation: data.generation,
      vectorClock: VectorClock.fromJSON(data.vectorClock),
    };
  }
}
