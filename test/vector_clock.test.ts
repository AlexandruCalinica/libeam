// test/vector_clock.test.ts

import { describe, it, expect } from 'vitest';
import { VectorClock } from '../src/vector_clock';

describe('VectorClock', () => {
  it('should initialize empty', () => {
    const vc = new VectorClock();
    expect(vc.get('node1')).toBe(0);
    expect(vc.isEmpty()).toBe(true);
  });

  it('should increment counters', () => {
    const vc = new VectorClock();
    vc.increment('node1');
    expect(vc.get('node1')).toBe(1);

    vc.increment('node1');
    expect(vc.get('node1')).toBe(2);

    vc.increment('node2');
    expect(vc.get('node2')).toBe(1);
    expect(vc.get('node1')).toBe(2);
  });

  it('should merge vector clocks correctly', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    vc1.increment('node1');
    vc1.increment('node2');
    // vc1 = {node1: 2, node2: 1}

    const vc2 = new VectorClock();
    vc2.increment('node1');
    vc2.increment('node2');
    vc2.increment('node2');
    vc2.increment('node3');
    // vc2 = {node1: 1, node2: 2, node3: 1}

    vc1.merge(vc2);
    // vc1 should be {node1: 2, node2: 2, node3: 1}
    expect(vc1.get('node1')).toBe(2);
    expect(vc1.get('node2')).toBe(2);
    expect(vc1.get('node3')).toBe(1);
  });

  it('should detect "before" relationship', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    // vc1 = {node1: 1}

    const vc2 = new VectorClock();
    vc2.increment('node1');
    vc2.increment('node1');
    // vc2 = {node1: 2}

    expect(vc1.compare(vc2)).toBe('before');
    expect(vc1.isLessThan(vc2)).toBe(true);
    expect(vc2.isGreaterThan(vc1)).toBe(true);
  });

  it('should detect "after" relationship', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    vc1.increment('node1');
    vc1.increment('node2');
    // vc1 = {node1: 2, node2: 1}

    const vc2 = new VectorClock();
    vc2.increment('node1');
    // vc2 = {node1: 1}

    expect(vc1.compare(vc2)).toBe('after');
    expect(vc1.isGreaterThan(vc2)).toBe(true);
    expect(vc2.isLessThan(vc1)).toBe(true);
  });

  it('should detect concurrent events', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    vc1.increment('node1');
    // vc1 = {node1: 2}

    const vc2 = new VectorClock();
    vc2.increment('node2');
    vc2.increment('node2');
    // vc2 = {node2: 2}

    expect(vc1.compare(vc2)).toBe('concurrent');
    expect(vc1.isConcurrent(vc2)).toBe(true);
    expect(vc2.isConcurrent(vc1)).toBe(true);
  });

  it('should detect concurrent events with partial overlap', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    vc1.increment('node1');
    vc1.increment('node2');
    // vc1 = {node1: 2, node2: 1}

    const vc2 = new VectorClock();
    vc2.increment('node1');
    vc2.increment('node2');
    vc2.increment('node2');
    // vc2 = {node1: 1, node2: 2}

    expect(vc1.compare(vc2)).toBe('concurrent');
    expect(vc1.isConcurrent(vc2)).toBe(true);
  });

  it('should clone correctly', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    vc1.increment('node2');

    const vc2 = vc1.clone();
    expect(vc2.get('node1')).toBe(1);
    expect(vc2.get('node2')).toBe(1);

    // Modifying clone should not affect original
    vc2.increment('node1');
    expect(vc2.get('node1')).toBe(2);
    expect(vc1.get('node1')).toBe(1);
  });

  it('should serialize to JSON and back', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    vc1.increment('node1');
    vc1.increment('node2');

    const json = vc1.toJSON();
    expect(json).toEqual({ node1: 2, node2: 1 });

    const vc2 = VectorClock.fromJSON(json);
    expect(vc2.get('node1')).toBe(2);
    expect(vc2.get('node2')).toBe(1);
    expect(vc2.compare(vc1)).toBe('concurrent'); // They're equal, but compare returns concurrent for equal clocks
  });

  it('should handle equal vector clocks as concurrent', () => {
    const vc1 = new VectorClock();
    vc1.increment('node1');
    vc1.increment('node2');

    const vc2 = new VectorClock();
    vc2.increment('node1');
    vc2.increment('node2');

    // Equal clocks are technically concurrent (neither dominates)
    expect(vc1.compare(vc2)).toBe('concurrent');
  });

  it('should provide readable string representation', () => {
    const vc = new VectorClock();
    vc.increment('node2');
    vc.increment('node1');
    vc.increment('node1');

    const str = vc.toString();
    // Should be sorted alphabetically
    expect(str).toBe('{node1:2, node2:1}');
  });
});
