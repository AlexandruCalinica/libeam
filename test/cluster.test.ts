// test/cluster.test.ts

import { Cluster, InMemoryTransport } from '../src';
import { vi } from 'vitest';

describe('Cluster', () => {
  it('should discover other nodes in the cluster', async () => {
    const transport = new InMemoryTransport();
    await transport.connect();

    const cluster1 = new Cluster(transport, { nodeId: 'node1', heartbeatIntervalMs: 50 });
    const cluster2 = new Cluster(transport, { nodeId: 'node2', heartbeatIntervalMs: 50 });

    const node1SeesNode2 = new Promise<void>(resolve => cluster1.on('member_join', (nodeId) => {
      if (nodeId === 'node2') resolve();
    }));

    const node2SeesNode1 = new Promise<void>(resolve => cluster2.on('member_join', (nodeId) => {
      if (nodeId === 'node1') resolve();
    }));

    await cluster1.start();
    await cluster2.start();

    await Promise.all([node1SeesNode2, node2SeesNode1]);

    expect(cluster1.getMembers()).toContain('node2');
    expect(cluster2.getMembers()).toContain('node1');

    await cluster1.stop();
    await cluster2.stop();
  }, 1000); // 1s timeout for this test

  it('should remove a node that has timed out', async () => {
    vi.useFakeTimers();

    const transport = new InMemoryTransport();
    await transport.connect();

    const cluster1 = new Cluster(transport, { nodeId: 'node1', heartbeatIntervalMs: 50, memberTimeoutMs: 150 });
    const cluster2 = new Cluster(transport, { nodeId: 'node2', heartbeatIntervalMs: 50, memberTimeoutMs: 150 });

    const leaveSpy = vi.fn();
    cluster1.on('member_leave', leaveSpy);

    await cluster1.start();
    await cluster2.start();

    // Ensure they see each other first
    vi.advanceTimersByTime(100);
    expect(cluster1.getMembers()).toEqual(expect.arrayContaining(['node1', 'node2']));

    // Stop node2 and wait for it to be considered stale
    await cluster2.stop();
    vi.advanceTimersByTime(200); // Past the 150ms timeout

    expect(cluster1.getMembers()).not.toContain('node2');
    expect(leaveSpy).toHaveBeenCalledWith('node2');

    await cluster1.stop();
    vi.useRealTimers();
  });
});
