// src/testing/faulty_transport.ts
//
// Transport decorator for fault injection. Wraps a real Transport (typically
// ZeroMQTransport) and intercepts request/send/publish to simulate network
// partitions. Used by TestCluster when faultInjection is enabled.
//
// Partition semantics:
// - "partitioned from nodeX" means: all outbound traffic TO nodeX is blocked
//   (requests throw TransportError, sends are silently dropped, publishes still
//   go through since PUB/SUB is topic-based, not peer-based).
// - Inbound traffic FROM a partitioned peer is NOT blocked at the transport
//   level — the remote node's FaultyTransport blocks it on their end.
//   Bidirectional partitions require calling partition() on both sides.

import {
  Transport,
  MessageHandler,
  RequestHandler,
  Subscription,
} from "../transport";
import { TransportError } from "../errors";
import { createLogger, Logger } from "../logger";

export class FaultyTransport implements Transport {
  private readonly partitionedPeers = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly inner: Transport) {
    this.log = createLogger("FaultyTransport", inner.getNodeId());
  }

  // ── Fault Injection API ───────────────────────────────────────

  /**
   * Block all outbound traffic to the given peer.
   * Requests will throw TransportError, sends will be silently dropped.
   */
  partition(nodeId: string): void {
    this.partitionedPeers.add(nodeId);
    this.log.info("Partitioned from peer", { nodeId });
  }

  /**
   * Restore outbound traffic to the given peer.
   */
  heal(nodeId: string): void {
    this.partitionedPeers.delete(nodeId);
    this.log.info("Healed partition to peer", { nodeId });
  }

  /**
   * Restore all partitions.
   */
  healAll(): void {
    this.partitionedPeers.clear();
    this.log.info("Healed all partitions");
  }

  /**
   * Check if a peer is currently partitioned.
   */
  isPartitioned(nodeId: string): boolean {
    return this.partitionedPeers.has(nodeId);
  }

  /**
   * Get all currently partitioned peer IDs.
   */
  getPartitionedPeers(): string[] {
    return Array.from(this.partitionedPeers);
  }

  // ── Transport Interface (delegating with fault injection) ─────

  getNodeId(): string {
    return this.inner.getNodeId();
  }

  async connect(): Promise<void> {
    return this.inner.connect();
  }

  async disconnect(): Promise<void> {
    this.partitionedPeers.clear();
    return this.inner.disconnect();
  }

  async request(nodeId: string, message: any, timeout: number): Promise<any> {
    if (this.partitionedPeers.has(nodeId)) {
      throw new TransportError(
        `Network partition: cannot reach ${nodeId}`,
        nodeId,
      );
    }
    return this.inner.request(nodeId, message, timeout);
  }

  async send(nodeId: string, message: any): Promise<void> {
    if (this.partitionedPeers.has(nodeId)) {
      // Silently drop — fire-and-forget semantics
      this.log.debug("Dropping send to partitioned peer", { nodeId });
      return;
    }
    return this.inner.send(nodeId, message);
  }

  async publish(topic: string, message: any): Promise<void> {
    // PUB/SUB is topic-based, not peer-based.
    // We pass through all publishes. The FaultyGossipUDP handles
    // gossip-level partitioning separately.
    return this.inner.publish(topic, message);
  }

  async subscribe(topic: string, handler: MessageHandler): Promise<Subscription> {
    return this.inner.subscribe(topic, handler);
  }

  onRequest(handler: RequestHandler): void {
    this.inner.onRequest(handler);
  }

  onMessage(handler: MessageHandler): void {
    this.inner.onMessage(handler);
  }

  updatePeers(peers: Array<[nodeId: string, address: string]>): void {
    this.inner.updatePeers(peers);
  }
}
