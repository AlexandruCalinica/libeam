// src/local_cluster.ts

import { EventEmitter } from "events";
import { Cluster, ClusterPeer } from "./cluster";
import { HealthCheckable, ComponentHealth } from "./health";

/**
 * A local-only cluster implementation for single-node deployments.
 * Provides a minimal Cluster interface that always returns self as the only member.
 * No gossip protocol or distributed features - suitable for development and testing.
 */
export class LocalCluster extends EventEmitter implements Cluster, HealthCheckable {
  public readonly nodeId: string;

  /**
   * Creates a new LocalCluster instance.
   * @param nodeId - The unique identifier for this node
   */
  constructor(nodeId: string) {
    super();
    this.nodeId = nodeId;
  }

  /**
   * Returns the list of all known member node IDs (only self).
   */
  getMembers(): string[] {
    return [this.nodeId];
  }

  /**
   * Returns detailed information about live peers (only self as healthy).
   */
  getLivePeers(): ClusterPeer[] {
    return [{ id: this.nodeId, status: "healthy" }];
  }

  /**
   * Returns health status for the single-node cluster.
   */
  getHealth(): ComponentHealth {
    return {
      name: "LocalCluster",
      status: "healthy",
      message: "Single-node cluster is healthy",
      details: {
        nodeId: this.nodeId,
        memberCount: 1,
      },
    };
  }
}
