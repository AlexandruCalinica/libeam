// src/vector_clock.ts

/**
 * A vector clock implementation for tracking causality in distributed systems.
 *
 * Vector clocks are used to determine the ordering of events in a distributed system
 * without relying on synchronized physical clocks. Each node maintains a counter for
 * every node in the system.
 *
 * Usage:
 * - Increment your node's counter when a local event occurs
 * - Merge with received vector clocks when receiving messages
 * - Compare vector clocks to determine causality relationships
 */
export class VectorClock {
  private clock: Map<string, number>;

  constructor(clock?: Map<string, number>) {
    this.clock = clock || new Map();
  }

  /**
   * Increments the counter for the given node ID.
   * Call this when the node performs a local event (e.g., actor registration).
   * @param nodeId The ID of the node to increment
   */
  increment(nodeId: string): void {
    const current = this.clock.get(nodeId) || 0;
    this.clock.set(nodeId, current + 1);
  }

  /**
   * Gets the counter value for a specific node.
   * @param nodeId The ID of the node
   * @returns The counter value, or 0 if the node is not in the clock
   */
  get(nodeId: string): number {
    return this.clock.get(nodeId) || 0;
  }

  /**
   * Merges another vector clock into this one.
   * Takes the maximum counter value for each node.
   * Call this when receiving a message from another node.
   * @param other The vector clock to merge
   */
  merge(other: VectorClock): void {
    for (const [nodeId, tick] of other.clock.entries()) {
      const current = this.clock.get(nodeId) || 0;
      this.clock.set(nodeId, Math.max(current, tick));
    }
  }

  /**
   * Compares this vector clock with another to determine causality.
   *
   * Returns:
   * - 'before': this happened before other (this < other)
   * - 'after': this happened after other (this > other)
   * - 'concurrent': events are concurrent (neither dominates)
   *
   * @param other The vector clock to compare with
   */
  compare(other: VectorClock): 'before' | 'after' | 'concurrent' {
    let hasGreater = false;
    let hasLess = false;

    // Collect all node IDs from both clocks
    const allNodes = new Set([
      ...this.clock.keys(),
      ...other.clock.keys(),
    ]);

    for (const nodeId of allNodes) {
      const a = this.get(nodeId);
      const b = other.get(nodeId);

      if (a > b) hasGreater = true;
      if (a < b) hasLess = true;
    }

    if (hasGreater && !hasLess) return 'after';
    if (hasLess && !hasGreater) return 'before';
    return 'concurrent';
  }

  /**
   * Checks if this vector clock is strictly less than another.
   * True if all counters are less than or equal, and at least one is strictly less.
   */
  isLessThan(other: VectorClock): boolean {
    return this.compare(other) === 'before';
  }

  /**
   * Checks if this vector clock is strictly greater than another.
   * True if all counters are greater than or equal, and at least one is strictly greater.
   */
  isGreaterThan(other: VectorClock): boolean {
    return this.compare(other) === 'after';
  }

  /**
   * Checks if this vector clock is concurrent with another.
   * True if some counters are greater and some are less.
   */
  isConcurrent(other: VectorClock): boolean {
    return this.compare(other) === 'concurrent';
  }

  /**
   * Creates a deep copy of this vector clock.
   */
  clone(): VectorClock {
    return new VectorClock(new Map(this.clock));
  }

  /**
   * Converts the vector clock to a plain JSON object for serialization.
   */
  toJSON(): { [nodeId: string]: number } {
    return Object.fromEntries(this.clock);
  }

  /**
   * Creates a vector clock from a JSON object.
   */
  static fromJSON(obj: { [nodeId: string]: number }): VectorClock {
    return new VectorClock(new Map(Object.entries(obj)));
  }

  /**
   * Returns a string representation of the vector clock.
   */
  toString(): string {
    const entries = Array.from(this.clock.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([nodeId, tick]) => `${nodeId}:${tick}`)
      .join(', ');
    return `{${entries}}`;
  }

  /**
   * Checks if the vector clock is empty (all counters are 0 or no entries).
   */
  isEmpty(): boolean {
    return this.clock.size === 0 || Array.from(this.clock.values()).every(v => v === 0);
  }
}
