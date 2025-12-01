// src/in_memory_transport.ts

import { EventEmitter } from "events";
import {
  Transport,
  Subscription,
  MessageHandler,
  RequestHandler,
} from "./transport";

/**
 * An in-memory implementation of the Transport interface, useful for testing
 * and single-node operation. It uses an EventEmitter to simulate channels.
 *
 * For multi-node testing, create multiple instances and wire them together
 * via a shared bus or use separate instances.
 */
export class InMemoryTransport implements Transport {
  private readonly bus = new EventEmitter();
  private readonly nodeId: string;
  private requestHandler?: RequestHandler;
  private messageHandler?: MessageHandler;
  private peers = new Map<string, InMemoryTransport>();

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  getNodeId(): string {
    return this.nodeId;
  }

  async connect(): Promise<void> {
    this.bus.setMaxListeners(100);
  }

  async disconnect(): Promise<void> {
    this.bus.removeAllListeners();
    this.peers.clear();
  }

  updatePeers(peers: Array<[nodeId: string, address: string]>): void {
    // For in-memory transport, address is ignored
    // Peers must be manually wired via setPeer()
    // This is fine for testing
  }

  /**
   * Manually wire another InMemoryTransport as a peer.
   * Only needed for multi-node testing scenarios.
   */
  setPeer(nodeId: string, transport: InMemoryTransport): void {
    this.peers.set(nodeId, transport);
  }

  async request(nodeId: string, message: any, timeout: number): Promise<any> {
    const peer = this.peers.get(nodeId);

    if (!peer) {
      // If no peer, assume it's local (same node)
      if (nodeId === this.nodeId && this.requestHandler) {
        return this.requestHandler(message);
      }
      throw new Error(`No peer found for node ${nodeId}`);
    }

    if (!peer.requestHandler) {
      throw new Error(`No request handler on peer ${nodeId}`);
    }

    // Simulate async behavior with timeout
    return Promise.race([
      peer.requestHandler(message),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Request timeout after ${timeout}ms`)),
          timeout,
        ),
      ),
    ]);
  }

  async send(nodeId: string, message: any): Promise<void> {
    const peer = this.peers.get(nodeId);

    if (!peer) {
      // If no peer, assume it's local
      if (nodeId === this.nodeId && this.messageHandler) {
        this.messageHandler(message);
        return;
      }
      throw new Error(`No peer found for node ${nodeId}`);
    }

    if (!peer.messageHandler) {
      // Fire-and-forget, so just drop if no handler
      return;
    }

    peer.messageHandler(message);
  }

  async publish(topic: string, message: any): Promise<void> {
    // Publish to local bus
    this.bus.emit(topic, message);

    // Also publish to all peers' buses
    for (const peer of this.peers.values()) {
      peer.bus.emit(topic, message);
    }
  }

  async subscribe(
    topic: string,
    handler: MessageHandler,
  ): Promise<Subscription> {
    this.bus.on(topic, handler);
    return {
      unsubscribe: async () => {
        this.bus.off(topic, handler);
      },
    };
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
}
