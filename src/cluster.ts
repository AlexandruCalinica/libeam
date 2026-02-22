// src/cluster.ts

import { EventEmitter } from "events";

/**
 * Peer information returned by getLivePeers.
 */
export interface ClusterPeer {
  id: string;
  status?: string;
}

/**
 * Interface for cluster membership management.
 * Implementations track which nodes are alive in the cluster.
 */
export interface Cluster {
  /**
   * This node's unique identifier.
   */
  readonly nodeId: string;

  /**
   * Gets the list of all known member node IDs (including self).
   */
  getMembers(): string[];

  /**
   * Gets detailed information about live peers (including self).
   * Returns array of peer objects with at least { id, status? }.
   */
  getLivePeers?(): ClusterPeer[];

  getMembersByRole?(role: string): string[];

  on?(event: string, listener: (...args: any[]) => void): this;

  removeListener?(event: string, listener: (...args: any[]) => void): this;
}
