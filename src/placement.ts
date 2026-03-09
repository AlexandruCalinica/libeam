// src/placement.ts

import { Cluster } from './cluster.js';
import { NoRoleMatchError } from './errors.js';

export type PlacementStrategy = 'local' | 'round-robin';

export class PlacementEngine {
  private roundRobinCounters = new Map<string, number>();

  constructor(private readonly cluster: Cluster) {}

  selectNode(strategy: PlacementStrategy, role?: string): string {
    switch (strategy) {
      case 'local': {
        if (role && this.cluster.getMembersByRole) {
          const matching = this.cluster.getMembersByRole(role);
          if (!matching.includes(this.cluster.nodeId)) {
            throw new NoRoleMatchError(role, this.cluster.nodeId);
          }
        }
        return this.cluster.nodeId;
      }
      case 'round-robin': {
        const members = role && this.cluster.getMembersByRole
          ? this.cluster.getMembersByRole(role)
          : this.cluster.getMembers();

        if (members.length === 0) {
          if (role) {
            throw new NoRoleMatchError(role);
          }
          return this.cluster.nodeId;
        }

        const counterKey = role ?? '__all__';
        const counter = (this.roundRobinCounters.get(counterKey) ?? -1) + 1;
        this.roundRobinCounters.set(counterKey, counter);
        return members[counter % members.length];
      }
      default:
        throw new Error(`Unknown placement strategy: ${strategy}`);
    }
  }
}
