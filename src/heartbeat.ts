// src/heartbeat.ts

import { EventEmitter } from "events";
import { Transport } from "./transport";
import { Cluster, ClusterPeer } from "./cluster";
import { createLogger, Logger } from "./logger";

/**
 * Configuration for the heartbeat protocol.
 */
export interface HeartbeatConfig {
  /** Enable/disable heartbeat protocol. Default: true */
  enabled: boolean;

  /** How often to run the heartbeat loop (ms). Default: 1000 */
  intervalMs: number;

  /** Timeout waiting for pong response (ms). Default: 2000 */
  timeoutMs: number;

  /** Number of missed heartbeats before declaring node dead. Default: 3 */
  maxMissedHeartbeats: number;

  /** Stagger pings across interval to avoid network bursts. Default: true */
  staggerPings: boolean;
}

/**
 * Default heartbeat configuration.
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  intervalMs: 1000,
  timeoutMs: 2000,
  maxMissedHeartbeats: 3,
  staggerPings: true,
};

/**
 * RPC message for heartbeat ping.
 */
export interface HeartbeatPing {
  type: "heartbeat:ping";
  timestamp: number;
  senderId: string;
}

/**
 * RPC message for heartbeat pong response.
 */
export interface HeartbeatPong {
  type: "heartbeat:pong";
  timestamp: number;
  responderId: string;
}

/**
 * Tracks heartbeat state for a single peer.
 */
interface PeerHeartbeatState {
  nodeId: string;
  missedCount: number;
  lastPongTime: number;
  pendingPing: boolean;
  isLeaving: boolean;
}

/**
 * HeartbeatManager provides active failure detection via ping/pong messages.
 *
 * It complements the passive gossip-based failure detection by actively
 * probing peers over the RPC transport layer, enabling faster detection
 * of node failures.
 *
 * Events:
 * - 'node_failed': Emitted when a node is detected as failed (missed too many heartbeats)
 *
 * @example
 * ```typescript
 * const heartbeat = new HeartbeatManager(nodeId, transport, cluster, config);
 * heartbeat.on('node_failed', (nodeId) => {
 *   console.log(`Node ${nodeId} failed`);
 *   system.handleNodeFailure(nodeId);
 * });
 * await heartbeat.start();
 * ```
 */
export class HeartbeatManager extends EventEmitter {
  private readonly nodeId: string;
  private readonly transport: Transport;
  private readonly cluster: Cluster;
  private readonly config: HeartbeatConfig;
  private readonly log: Logger;

  private readonly peerStates = new Map<string, PeerHeartbeatState>();
  private heartbeatTimer?: NodeJS.Timeout;
  private staggerTimers: NodeJS.Timeout[] = [];
  private _isRunning = false;

  // Bound event handlers for proper removal
  private readonly boundHandleMemberJoin: (peer: string | ClusterPeer) => void;
  private readonly boundHandleMemberLeave: (peer: string | ClusterPeer) => void;

  constructor(
    nodeId: string,
    transport: Transport,
    cluster: Cluster,
    config: Partial<HeartbeatConfig> = {},
  ) {
    super();
    this.nodeId = nodeId;
    this.transport = transport;
    this.cluster = cluster;
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
    this.log = createLogger("HeartbeatManager", nodeId);

    // Bind event handlers once for proper removal
    this.boundHandleMemberJoin = this.handleMemberJoin.bind(this);
    this.boundHandleMemberLeave = this.handleMemberLeave.bind(this);
  }

  /**
   * Returns whether the heartbeat manager is currently running.
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Starts the heartbeat manager.
   * Begins periodic ping/pong exchanges with all known peers.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.log.info("Heartbeat disabled by configuration");
      return;
    }

    if (this._isRunning) {
      this.log.warn("HeartbeatManager already running");
      return;
    }

    this._isRunning = true;
    this.log.info("Starting heartbeat manager", {
      intervalMs: this.config.intervalMs,
      timeoutMs: this.config.timeoutMs,
      maxMissedHeartbeats: this.config.maxMissedHeartbeats,
      staggerPings: this.config.staggerPings,
    });

    // Initialize peer states from current cluster members
    this.initializePeerStates();

    // Listen for cluster membership changes (if cluster supports events)
    if (this.cluster.on) {
      this.cluster.on("member_join", this.boundHandleMemberJoin);
      this.cluster.on("member_leave", this.boundHandleMemberLeave);
    }

    // Start the heartbeat loop
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatLoop();
    }, this.config.intervalMs);

    // Run first heartbeat immediately
    this.heartbeatLoop();
  }

  /**
   * Stops the heartbeat manager.
   * Cancels all pending pings and timers.
   */
  async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    this.log.info("Stopping heartbeat manager");
    this._isRunning = false;

    // Clear the main heartbeat timer
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Clear all stagger timers
    for (const timer of this.staggerTimers) {
      clearTimeout(timer);
    }
    this.staggerTimers = [];

    // Remove cluster event listeners (if cluster supports events)
    if (this.cluster.removeListener) {
      this.cluster.removeListener("member_join", this.boundHandleMemberJoin);
      this.cluster.removeListener("member_leave", this.boundHandleMemberLeave);
    }

    // Clear peer states
    this.peerStates.clear();
  }

  /**
   * Handles a heartbeat ping request and returns a pong response.
   * This should be called by the ActorSystem's RPC handler.
   */
  handlePing(ping: HeartbeatPing): HeartbeatPong {
    this.log.debug("Received ping", {
      from: ping.senderId,
      timestamp: ping.timestamp,
    });
    return {
      type: "heartbeat:pong",
      timestamp: ping.timestamp,
      responderId: this.nodeId,
    };
  }

  /**
   * Initialize peer states from current cluster members.
   */
  private initializePeerStates(): void {
    // Use getLivePeers if available, otherwise fall back to getMembers
    if (this.cluster.getLivePeers) {
      const peers = this.cluster.getLivePeers();
      for (const peer of peers) {
        if (peer.id !== this.nodeId) {
          this.addPeer(peer.id);
        }
      }
    } else {
      const memberIds = this.cluster.getMembers();
      for (const memberId of memberIds) {
        if (memberId !== this.nodeId) {
          this.addPeer(memberId);
        }
      }
    }
    this.log.debug("Initialized peer states", {
      peerCount: this.peerStates.size,
    });
  }

  /**
   * Add a peer to heartbeat tracking.
   */
  private addPeer(nodeId: string): void {
    if (this.peerStates.has(nodeId)) {
      return;
    }
    this.peerStates.set(nodeId, {
      nodeId,
      missedCount: 0,
      lastPongTime: Date.now(),
      pendingPing: false,
      isLeaving: false,
    });
    this.log.debug("Added peer to heartbeat tracking", { nodeId });
  }

  /**
   * Remove a peer from heartbeat tracking.
   */
  private removePeer(nodeId: string): void {
    if (this.peerStates.delete(nodeId)) {
      this.log.debug("Removed peer from heartbeat tracking", { nodeId });
    }
  }

  /**
   * Handle cluster member join event.
   * Event may emit either a string nodeId or an object with { id: string }.
   */
  private handleMemberJoin(peer: string | ClusterPeer): void {
    const nodeId = typeof peer === "string" ? peer : peer.id;
    if (nodeId !== this.nodeId) {
      this.addPeer(nodeId);
    }
  }

  /**
   * Handle cluster member leave event.
   * Event may emit either a string nodeId or an object with { id: string, status?: string }.
   */
  private handleMemberLeave(peer: string | ClusterPeer): void {
    const nodeId = typeof peer === "string" ? peer : peer.id;
    const status = typeof peer === "string" ? undefined : peer.status;

    const state = this.peerStates.get(nodeId);
    if (!state) {
      return;
    }

    if (status === "leaving") {
      // Graceful leave - mark as leaving and remove without failure event
      this.log.debug("Peer gracefully leaving", { nodeId });
      state.isLeaving = true;
      this.removePeer(nodeId);
    } else {
      // Failure detected by gossip - just remove from tracking
      // (gossip already detected the failure, no need to emit again)
      this.log.debug("Peer failed (detected by gossip)", { nodeId });
      this.removePeer(nodeId);
    }
  }

  /**
   * Main heartbeat loop - sends pings to all peers.
   */
  private heartbeatLoop(): void {
    if (!this._isRunning) {
      return;
    }

    const peers = Array.from(this.peerStates.values()).filter(
      (p) => !p.isLeaving,
    );

    if (peers.length === 0) {
      return;
    }

    if (this.config.staggerPings && peers.length > 1) {
      // Stagger pings across the interval
      const staggerDelayMs = this.config.intervalMs / peers.length;
      peers.forEach((peer, index) => {
        const timer = setTimeout(() => {
          this.pingPeer(peer);
        }, index * staggerDelayMs);
        this.staggerTimers.push(timer);
      });

      // Clean up old stagger timers after interval completes
      setTimeout(() => {
        this.staggerTimers = [];
      }, this.config.intervalMs);
    } else {
      // Send all pings at once
      for (const peer of peers) {
        this.pingPeer(peer);
      }
    }
  }

  /**
   * Send a ping to a single peer and handle the response.
   */
  private async pingPeer(state: PeerHeartbeatState): Promise<void> {
    if (!this._isRunning || state.isLeaving) {
      return;
    }

    // Check if previous ping is still pending
    if (state.pendingPing) {
      state.missedCount++;
      this.log.debug("Missed heartbeat", {
        nodeId: state.nodeId,
        missedCount: state.missedCount,
        maxMissedHeartbeats: this.config.maxMissedHeartbeats,
      });

      if (state.missedCount >= this.config.maxMissedHeartbeats) {
        this.log.warn("Node failed - exceeded max missed heartbeats", {
          nodeId: state.nodeId,
          missedCount: state.missedCount,
        });
        this.removePeer(state.nodeId);
        this.emit("node_failed", state.nodeId);
        return;
      }
    }

    // Send ping
    state.pendingPing = true;
    const ping: HeartbeatPing = {
      type: "heartbeat:ping",
      timestamp: Date.now(),
      senderId: this.nodeId,
    };

    try {
      const pong: HeartbeatPong = await this.transport.request(
        state.nodeId,
        ping,
        this.config.timeoutMs,
      );

      // Handle pong response
      if (pong.type === "heartbeat:pong" && this.peerStates.has(state.nodeId)) {
        const currentState = this.peerStates.get(state.nodeId)!;
        currentState.pendingPing = false;
        currentState.missedCount = 0;
        currentState.lastPongTime = Date.now();

        const rtt = Date.now() - pong.timestamp;
        this.log.debug("Received pong", {
          from: pong.responderId,
          rttMs: rtt,
        });
      }
    } catch (error) {
      // Timeout or transport error - will be counted as missed on next iteration
      this.log.debug("Ping failed", {
        nodeId: state.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get the current heartbeat state for a peer (for testing/debugging).
   */
  getPeerState(nodeId: string): PeerHeartbeatState | undefined {
    return this.peerStates.get(nodeId);
  }

  /**
   * Get all tracked peer node IDs (for testing/debugging).
   */
  getTrackedPeers(): string[] {
    return Array.from(this.peerStates.keys());
  }
}
