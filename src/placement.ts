// src/placement.ts

import { Cluster } from './cluster';
import { Actor } from './actor';

export type PlacementStrategy = 'local' | 'round-robin';

/**
 * The placement engine is responsible for deciding which node an actor
 * should be spawned on.
 */
export class PlacementEngine {
  private roundRobinCounter = 0;

  constructor(private readonly cluster: Cluster) {}

  /**
   * Selects a node ID based on the given strategy.
   * @param strategy The placement strategy to use.
   * @returns The ID of the selected node.
   */
  selectNode(strategy: PlacementStrategy): string {
    switch (strategy) {
      case 'local':
        return this.cluster.nodeId;
      case 'round-robin':
        const members = this.cluster.getMembers();
        if (members.length === 0) {
          return this.cluster.nodeId;
        }
        this.roundRobinCounter = (this.roundRobinCounter + 1) % members.length;
        return members[this.roundRobinCounter];
      default:
        throw new Error(`Unknown placement strategy: ${strategy}`);
    }
  }
}
