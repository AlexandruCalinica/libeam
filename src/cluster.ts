// src/cluster.ts

import { EventEmitter } from 'events';
import { Transport, Subscription } from './transport';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_MEMBER_TIMEOUT_MS = 15000;
const HEARTBEAT_CHANNEL = 'cluster:heartbeat';

export interface Node {
  id: string;
  lastSeen: number;
}

export interface ClusterOptions {
  nodeId?: string;
  heartbeatIntervalMs?: number;
  memberTimeoutMs?: number;
}

/**
 * Manages the membership of nodes in the cluster.
 * It uses the transport layer to send and receive heartbeats.
 */
export class Cluster extends EventEmitter {
  public readonly nodeId: string;
  private readonly transport: Transport;
  private readonly members = new Map<string, Node>();
  private readonly heartbeatIntervalMs: number;
  private readonly memberTimeoutMs: number;
  private heartbeatTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private heartbeatSubscription?: Subscription;

  constructor(transport: Transport, options?: ClusterOptions) {
    super();
    this.transport = transport;
    this.nodeId = options?.nodeId || uuidv4();
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.memberTimeoutMs = options?.memberTimeoutMs || DEFAULT_MEMBER_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    // Add self to the list of members
    this.members.set(this.nodeId, { id: this.nodeId, lastSeen: Date.now() });

    this.heartbeatSubscription = await this.transport.subscribe(HEARTBEAT_CHANNEL, this.handleHeartbeat.bind(this));

    this.heartbeatTimer = setInterval(() => {
      this.transport.publish(HEARTBEAT_CHANNEL, { nodeId: this.nodeId });
    }, this.heartbeatIntervalMs);

    this.cleanupTimer = setInterval(() => {
      this.cleanupMembers();
    }, this.memberTimeoutMs);

    // Announce presence
    this.transport.publish(HEARTBEAT_CHANNEL, { nodeId: this.nodeId });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    if (this.heartbeatSubscription) {
      await this.heartbeatSubscription.unsubscribe();
    }
    this.members.clear();
  }

  getMembers(): string[] {
    return Array.from(this.members.keys());
  }

  private handleHeartbeat({ nodeId }: { nodeId: string }): void {
    if (!this.members.has(nodeId)) {
      this.emit('member_join', nodeId);
    }
    this.members.set(nodeId, { id: nodeId, lastSeen: Date.now() });
  }

  private cleanupMembers(): void {
    const now = Date.now();
    for (const [nodeId, member] of this.members.entries()) {
      const elapsed = now - member.lastSeen;
      if (elapsed >= this.memberTimeoutMs) {
        this.members.delete(nodeId);
        this.emit('member_leave', nodeId);
      }
    }
  }
}
