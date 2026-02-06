// src/distributed_cluster.ts

import { EventEmitter } from "events";
import { GossipProtocol, PeerState } from "./gossip_protocol";
import { Cluster } from "./cluster";
import { HealthCheckable, ComponentHealth } from "./health";

/**
 * A wrapper around the GossipProtocol that provides a cluster interface
 * compatible with the ActorSystem.
 */
export class DistributedCluster
  extends EventEmitter
  implements Cluster, HealthCheckable
{
  public readonly nodeId: string;
  private gossipProtocol: GossipProtocol;

  constructor(gossipProtocol: GossipProtocol) {
    super();
    this.gossipProtocol = gossipProtocol;
    this.nodeId = gossipProtocol.getNodeId(); // Assuming GossipProtocol has a way to get its own ID

    // Re-emit events from gossip protocol
    this.gossipProtocol.on("member_join", (peer: PeerState) => {
      this.emit("member_join", peer.id);
    });
    this.gossipProtocol.on("member_leave", (peer: PeerState) => {
      this.emit("member_leave", peer.id);
    });
    this.gossipProtocol.on("member_update", (peer: PeerState) => {
      // Potentially emit member_update or just ignore if ActorSystem doesn't need it
    });
  }

  async start(): Promise<void> {
    await this.gossipProtocol.start();
  }

  async stop(): Promise<void> {
    await this.gossipProtocol.stop();
  }

  /**
   * Gracefully leaves the cluster by notifying peers before stopping.
   * Prefer this over stop() for graceful shutdown.
   * @param broadcastCount Number of times to broadcast leave message. Default: 3
   * @param intervalMs Interval between broadcasts in ms. Default: 100
   */
  async leave(broadcastCount = 3, intervalMs = 100): Promise<void> {
    await this.gossipProtocol.leave(broadcastCount, intervalMs);
  }

  /**
   * Returns true if this node is in the process of leaving the cluster.
   */
  isLeaving(): boolean {
    return this.gossipProtocol.isLeaving();
  }

  getMembers(): string[] {
    return this.gossipProtocol.getLivePeers().map((p) => p.id);
  }

  getLivePeers(): PeerState[] {
    return this.gossipProtocol.getLivePeers();
  }

  getPeerState(nodeId: string): PeerState | undefined {
    return this.gossipProtocol.getLivePeers().find((p) => p.id === nodeId);
  }

  /**
   * Returns health status of the cluster.
   */
  getHealth(): ComponentHealth {
    const livePeers = this.gossipProtocol.getLivePeers();
    const peerCount = livePeers.length;
    const isLeaving = this.gossipProtocol.isLeaving();

    if (isLeaving) {
      return {
        name: "Cluster",
        status: "degraded",
        message: "Node is leaving the cluster",
        details: { peerCount, isLeaving },
      };
    }

    // Single node is healthy but potentially degraded if we expect more peers
    if (peerCount === 1) {
      return {
        name: "Cluster",
        status: "healthy",
        message: "Single node cluster",
        details: {
          peerCount,
          peers: livePeers.map((p) => p.id),
        },
      };
    }

    return {
      name: "Cluster",
      status: "healthy",
      message: `Connected to ${peerCount - 1} peer(s)`,
      details: {
        peerCount,
        peers: livePeers.map((p) => p.id),
      },
    };
  }
}
