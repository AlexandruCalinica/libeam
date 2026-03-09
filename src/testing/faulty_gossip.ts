// src/testing/faulty_gossip.ts
//
// GossipUDP wrapper for fault injection. Intercepts both outbound sends
// and inbound messages to simulate network partitions at the gossip layer.
//
// This is used alongside FaultyTransport to create complete network
// partitions — when a node is partitioned, both ZeroMQ RPC and UDP gossip
// are blocked. Without this, gossip would still detect partitioned nodes
// as alive, which doesn't match real network partition behavior.
//
// Usage: Controlled via IPC from TestCluster. Not used directly in tests.

import { EventEmitter } from "node:events";
import type { GossipUDP } from "../gossip_udp.js";
import type { GossipMessage } from "../gossip.js";
import { createLogger, Logger } from "../logger.js";

/**
 * FaultyGossipUDP — wraps a real GossipUDP instance and selectively
 * drops gossip messages to/from partitioned peers.
 *
 * Partitions are bidirectional at the individual node level:
 * - Outbound: `send()` calls to partitioned gossip addresses are silently dropped
 * - Inbound: messages from partitioned senderIds are silently dropped
 *
 * For a full partition between nodeA and nodeB, both nodes must call
 * `partition()` (or TestCluster handles this automatically).
 */
export class FaultyGossipUDP extends EventEmitter {
  /** Gossip addresses to block outbound sends to (e.g., "127.0.0.1:5002") */
  private readonly partitionedAddresses = new Set<string>();
  /** Node IDs to block inbound messages from */
  private readonly partitionedNodeIds = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly inner: GossipUDP) {
    super();
    this.log = createLogger("FaultyGossipUDP");

    // Forward "message" events from inner, filtering out partitioned senders
    this.inner.on("message", (message: GossipMessage, rinfo: any) => {
      if (this.partitionedNodeIds.has(message.senderId)) {
        this.log.debug("Dropping inbound gossip from partitioned peer", {
          senderId: message.senderId,
        });
        return;
      }
      this.emit("message", message, rinfo);
    });
  }

  // ── Fault Injection API ───────────────────────────────────────

  /**
   * Block gossip traffic to/from a peer.
   * @param nodeId The peer's nodeId (blocks inbound)
   * @param gossipAddress The peer's gossip address "host:port" (blocks outbound)
   */
  partition(nodeId: string, gossipAddress: string): void {
    this.partitionedNodeIds.add(nodeId);
    this.partitionedAddresses.add(gossipAddress);
    this.log.info("Partitioned from gossip peer", { nodeId, gossipAddress });
  }

  /**
   * Restore gossip traffic to/from a peer.
   * @param nodeId The peer's nodeId (unblocks inbound)
   * @param gossipAddress The peer's gossip address "host:port" (unblocks outbound)
   */
  heal(nodeId: string, gossipAddress: string): void {
    this.partitionedNodeIds.delete(nodeId);
    this.partitionedAddresses.delete(gossipAddress);
    this.log.info("Healed gossip partition to peer", { nodeId, gossipAddress });
  }

  /**
   * Restore all gossip partitions.
   */
  healAll(): void {
    this.partitionedNodeIds.clear();
    this.partitionedAddresses.clear();
    this.log.info("Healed all gossip partitions");
  }

  // ── GossipUDP-compatible interface ────────────────────────────
  // GossipProtocol expects: start(), stop(), send(), on("message", ...)

  async start(): Promise<void> {
    return this.inner.start();
  }

  async stop(): Promise<void> {
    this.partitionedNodeIds.clear();
    this.partitionedAddresses.clear();
    return this.inner.stop();
  }

  async send(
    message: GossipMessage,
    targetAddress: string,
    targetPort: number,
  ): Promise<void> {
    const target = `${targetAddress}:${targetPort}`;
    if (this.partitionedAddresses.has(target)) {
      this.log.debug("Dropping outbound gossip to partitioned address", {
        target,
      });
      return;
    }
    return this.inner.send(message, targetAddress, targetPort);
  }
}
