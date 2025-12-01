// src/cluster.ts

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
}
