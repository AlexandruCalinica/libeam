// src/gossip_protocol.ts

import type { Authenticator } from "./auth";
import { GossipMessage, PeerState, PeerStatus } from "./gossip";

// Re-export PeerState and PeerStatus for consumers of this module
export { PeerState, PeerStatus } from "./gossip";
import { GossipUDP } from "./gossip_udp";
import { Logger, createLogger } from "./logger";
import { EventEmitter } from "events";
import * as dgram from "dgram";

export interface GossipOptions {
  /** Interval in ms to send gossip messages. */
  gossipIntervalMs: number;
  /** Interval in ms to run the failure detection loop. */
  cleanupIntervalMs: number;
  /** Time in ms after which a peer is considered dead if no updates are received. */
  failureTimeoutMs: number;
  /** Number of random peers to send gossip to. */
  gossipFanout: number;
  /** List of seed nodes (UDP addresses) to connect to initially. */
  seedNodes: string[]; // e.g., ['127.0.0.1:6000']
}

export class GossipProtocol extends EventEmitter {
  private self: PeerState;
  private peers = new Map<string, PeerState>(); // key: PeerState.id
  private gossipIntervalTimer?: NodeJS.Timeout;
  private cleanupIntervalTimer?: NodeJS.Timeout;
  private _isLeaving = false;
  private readonly log: Logger;
  private hasWarnedOpenModeReceive = false;

  constructor(
    nodeId: string,
    rpcAddress: string, // ZeroMQ address
    gossipAddress: string, // UDP address (e.g., 127.0.0.1:6000)
    private readonly gossipUDP: GossipUDP,
    private readonly options: GossipOptions,
    private readonly auth?: Authenticator,
  ) {
    super();
    this.log = createLogger("GossipProtocol", nodeId).child({ gossipAddress });
    this.self = {
      id: nodeId,
      address: rpcAddress,
      heartbeat: 0,
      generation: Date.now(),
      gossipAddress: gossipAddress, // Store full address as string
      lastUpdated: Date.now(),
      status: "alive",
    };
    this.peers.set(this.self.id, this.self);
  }

  /**
   * Returns true if this node is in the process of leaving the cluster.
   */
  isLeaving(): boolean {
    return this._isLeaving;
  }

  public getNodeId(): string {
    return this.self.id;
  }

  async start(): Promise<void> {
    this.gossipUDP.on("message", this.handleGossipMessage.bind(this));
    await this.gossipUDP.start();

    this.gossipIntervalTimer = setInterval(() => {
      this.gossipLoop();
    }, this.options.gossipIntervalMs);

    this.cleanupIntervalTimer = setInterval(() => {
      this.failureDetectionLoop();
    }, this.options.cleanupIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.gossipIntervalTimer) {
      clearInterval(this.gossipIntervalTimer);
    }
    if (this.cleanupIntervalTimer) {
      clearInterval(this.cleanupIntervalTimer);
    }
    await this.gossipUDP.stop();
    this.peers.clear();
  }

  /**
   * Gracefully leaves the cluster by notifying peers before stopping.
   * This broadcasts a "leaving" status to all known peers, giving them
   * a chance to update their membership views before this node goes offline.
   * @param broadcastCount Number of times to broadcast leave message. Default: 3
   * @param intervalMs Interval between broadcasts in ms. Default: 100
   */
  async leave(broadcastCount = 3, intervalMs = 100): Promise<void> {
    if (this._isLeaving) {
      return; // Already leaving
    }

    this._isLeaving = true;
    this.self.status = "leaving";
    this.self.heartbeat++;
    this.self.lastUpdated = Date.now();
    this.peers.set(this.self.id, this.self);

    // Broadcast leave message multiple times to ensure delivery
    for (let i = 0; i < broadcastCount; i++) {
      await this._broadcastToAllPeers();
      if (i < broadcastCount - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    // Now stop the protocol
    await this.stop();
  }

  /**
   * Broadcasts current state to all known peers.
   */
  private async _broadcastToAllPeers(): Promise<void> {
    const allPeers = this.getAllKnownPeers().filter(
      (p) => p.id !== this.self.id,
    );

    const sendPromises = allPeers.map((peer) => {
      const [host, portStr] = peer.gossipAddress.split(":");
      const port = parseInt(portStr, 10);
      return this.gossipUDP
        .send(
          {
            senderId: this.self.id,
            peers: this.getAllKnownPeers(),
          },
          host,
          port,
        )
        .catch(() => {
          // Ignore send errors during leave
        });
    });

    await Promise.all(sendPromises);
  }

  getLivePeers(): PeerState[] {
    // Return peers including self, filtered by failure timeout and excluding "leaving" peers
    return Array.from(this.peers.values()).filter((p) => {
      // Exclude peers that are leaving (unless it's self)
      if (p.status === "leaving" && p.id !== this.self.id) {
        return false;
      }
      // Include self or peers within timeout
      return (
        p.id === this.self.id ||
        Date.now() - p.lastUpdated < this.options.failureTimeoutMs
      );
    });
  }

  getAllKnownPeers(): PeerState[] {
    return Array.from(this.peers.values());
  }

  private gossipLoop(): void {
    this.self.heartbeat++;
    this.self.lastUpdated = Date.now();
    this.peers.set(this.self.id, this.self); // Ensure self is always up-to-date in its own table

    let peersToGossipTo: PeerState[] = [];
    const allKnownPeersExcludingSelf = this.getAllKnownPeers().filter(
      (p) => p.id !== this.self.id,
    );

    if (allKnownPeersExcludingSelf.length > 0) {
      const shuffledPeers = this.shuffleArray(allKnownPeersExcludingSelf);
      peersToGossipTo = shuffledPeers.slice(0, this.options.gossipFanout);
    } else if (this.options.seedNodes.length > 0) {
      // If no known peers (other than self), try to connect to a random seed node
      const randomSeedGossipAddress =
        this.options.seedNodes[
          Math.floor(Math.random() * this.options.seedNodes.length)
        ];
      const [host, portStr] = randomSeedGossipAddress.split(":");
      const port = parseInt(portStr, 10);
      this.sendGossipMessage(host, port);
      return; // Only send to one seed for now if no peers
    } else {
      // No known peers and no seed nodes, nothing to do.
      return;
    }

    peersToGossipTo.forEach((peer) => {
      const [host, portStr] = peer.gossipAddress.split(":");
      const port = parseInt(portStr, 10);
      this.sendGossipMessage(host, port);
    });
  }

  private sendGossipMessage(host: string, port: number): void {
    const message: GossipMessage = {
      senderId: this.self.id,
      peers: this.getAllKnownPeers(), // Send our entire view of ALL known peers
    };
    this.gossipUDP.send(message, host, port).catch((err) => {
      // Error handling for UDP send, e.g., network issues
      // console.warn(`[${this.self.id}] Failed to send gossip to ${host}:${port}: ${err.message}`);
    });
  }

  private handleGossipMessage(
    message: GossipMessage,
    rinfo: dgram.RemoteInfo,
  ): void {
    if (!this.auth && !this.hasWarnedOpenModeReceive) {
      this.hasWarnedOpenModeReceive = true;
      this.log.warn("Received gossip message without authentication configured", {
        from: `${rinfo.address}:${rinfo.port}`,
      });
    }

    // Merge incoming peer state with local state
    message.peers.forEach((incomingPeer) => {
      const localPeer = this.peers.get(incomingPeer.id);

      if (!localPeer) {
        // New peer discovered - but don't add if they're already leaving
        if (incomingPeer.status === "leaving") {
          return;
        }
        this.peers.set(incomingPeer.id, {
          ...incomingPeer,
          lastUpdated: Date.now(),
        });
        this.emit("member_join", incomingPeer);
        return;
      }

      // Merge logic: higher heartbeat or generation wins
      if (incomingPeer.generation > localPeer.generation) {
        // New generation (restart) always wins
        this.peers.set(incomingPeer.id, {
          ...incomingPeer,
          lastUpdated: Date.now(),
        });
        this.emit("member_update", incomingPeer);
      } else if (incomingPeer.generation === localPeer.generation) {
        if (incomingPeer.heartbeat > localPeer.heartbeat) {
          // Higher heartbeat within same generation wins
          const wasAlive = localPeer.status !== "leaving";
          const isNowLeaving = incomingPeer.status === "leaving";

          this.peers.set(incomingPeer.id, {
            ...incomingPeer,
            lastUpdated: Date.now(),
          });

          // Emit member_leave if peer transitioned to leaving
          if (wasAlive && isNowLeaving) {
            this.emit("member_leave", incomingPeer);
          } else {
            this.emit("member_update", incomingPeer);
          }
        }
      }
    });
  }

  private failureDetectionLoop(): void {
    const now = Date.now();
    for (const [id, peer] of this.peers.entries()) {
      if (id === this.self.id) continue; // Don't check self

      if (now - peer.lastUpdated > this.options.failureTimeoutMs) {
        // Peer is considered dead
        this.peers.delete(id);
        this.emit("member_leave", peer);
      }
    }
  }

  // Fisher-Yates shuffle algorithm
  private shuffleArray<T>(array: T[]): T[] {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }
}
