import { describe, it, expect } from "vitest";
import * as path from "path";
import { TestCluster } from "../src";

// Helper: sleep
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Path to actor module that workers will load in-process.
// This avoids the serialization issue with sending createActor definitions over ZeroMQ.
const TEST_ACTOR_MODULE = path.resolve(__dirname, "fixtures/test_actors.ts");

// These are integration tests that create real distributed clusters with
// ZeroMQ transport and UDP gossip. They are inherently timing-sensitive
// because they involve OS-level resources (ports, sockets, processes).
//
// Each test gets { retry: 2 } to handle transient failures from
// port contention or gossip convergence timing.

describe("TestCluster", () => {
  // ── Single-Node Cluster ────────────────────────────────────────

  it("should create a 1-node cluster with ping, info, actor IDs, and custom prefix", { timeout: 120000, retry: 2 }, async () => {
    // Test 1: Standard 1-node cluster
    const cluster = await TestCluster.create({ size: 1, timeout: 30000 });
    try {
      const members = cluster.system.cluster.getMembers();
      // 1 worker + 1 controller = 2 members
      expect(members.length).toBe(2);
      expect(cluster.nodes.length).toBe(1);
      expect(cluster.nodes[0].nodeId).toContain("test-node");

      // Ping the remote NodeAgent
      const result = await cluster.nodes[0].agent.call({
        method: "ping",
        args: [],
      });
      expect(result).toBe("pong");

      // Get node info
      const info = await cluster.nodes[0].agent.call({
        method: "getNodeInfo",
        args: [],
      });
      expect(info.nodeId).toBe(cluster.nodes[0].nodeId);
      expect(info.uptime).toBeGreaterThan(0);
      expect(info.memoryUsage).toBeDefined();
      expect(info.actorCount).toBeGreaterThanOrEqual(1);

      // Get actor IDs
      const ids = await cluster.nodes[0].agent.call({
        method: "getActorIds",
        args: [],
      });
      expect(Array.isArray(ids)).toBe(true);
      expect(ids.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }

    // Test 2: Custom nodeId prefix
    const cluster2 = await TestCluster.create({
      size: 1,
      timeout: 30000,
      nodeIdPrefix: "custom-prefix",
    });
    try {
      expect(cluster2.nodes[0].nodeId).toContain("custom-prefix");
    } finally {
      await cluster2.teardown();
      await sleep(3000);
    }
  });

  // ── Remote Actor Management (single node) ─────────────────────

  it("should spawn, call, cast, and stop actors on a remote node via actorModules", { timeout: 60000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({
      size: 1,
      timeout: 30000,
      actorModules: [TEST_ACTOR_MODULE],
    });
    try {
      // Spawn Counter on the remote node (loaded via actorModules)
      const actorId = await cluster.nodes[0].agent.call({
        method: "spawn",
        args: ["Counter", { name: "remote-counter", args: [42] }],
      });
      expect(actorId).toBeDefined();
      expect(typeof actorId).toBe("string");

      // Call the remote actor from the controller via registry lookup
      await sleep(500);
      const ref = await cluster.system.getActorByName("remote-counter");
      expect(ref).not.toBeNull();
      const value = await ref!.call({ method: "get", args: [] });
      expect(value).toBe(42);

      // callActor via NodeAgent
      const callValue = await cluster.nodes[0].agent.call({
        method: "callActor",
        args: ["remote-counter", "get"],
      });
      expect(callValue).toBe(42);

      // increment via callActor
      await cluster.nodes[0].agent.call({
        method: "callActor",
        args: ["remote-counter", "increment"],
      });
      const incremented = await cluster.nodes[0].agent.call({
        method: "callActor",
        args: ["remote-counter", "get"],
      });
      expect(incremented).toBe(43);

      // castActor via NodeAgent
      await cluster.nodes[0].agent.call({
        method: "castActor",
        args: ["remote-counter", "set", 99],
      });
      await sleep(200);
      const castValue = await cluster.nodes[0].agent.call({
        method: "callActor",
        args: ["remote-counter", "get"],
      });
      expect(castValue).toBe(99);

      // getActorIds includes our counter
      const idsBefore: string[] = await cluster.nodes[0].agent.call({
        method: "getActorIds",
        args: [],
      });

      // stopActor
      const stopped = await cluster.nodes[0].agent.call({
        method: "stopActor",
        args: ["remote-counter"],
      });
      expect(stopped).toBe(true);

      const idsAfter: string[] = await cluster.nodes[0].agent.call({
        method: "getActorIds",
        args: [],
      });
      expect(idsAfter.length).toBeLessThan(idsBefore.length);
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  // ── Multi-Node Cluster ─────────────────────────────────────────

  it("should create a 2-node cluster, ping, and cross-node actor calls", { timeout: 90000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({
      size: 2,
      timeout: 30000,
      actorModules: [TEST_ACTOR_MODULE],
    });
    try {
      const members = cluster.system.cluster.getMembers();
      // 2 workers + 1 controller = 3 members
      expect(members.length).toBe(3);
      expect(cluster.nodes.length).toBe(2);

      // Each node should have a unique nodeId
      const nodeIds = cluster.nodes.map((n) => n.nodeId);
      expect(new Set(nodeIds).size).toBe(2);

      // Ping all nodes
      for (const node of cluster.nodes) {
        const result = await node.agent.call({
          method: "ping",
          args: [],
        });
        expect(result).toBe("pong");
      }

      // Spawn counter on node 0
      await cluster.nodes[0].agent.call({
        method: "spawn",
        args: ["Counter", { name: "counter-a", args: [100] }],
      });

      // Spawn counter on node 1
      await cluster.nodes[1].agent.call({
        method: "spawn",
        args: ["Counter", { name: "counter-b", args: [200] }],
      });

      // Wait for registry sync
      await sleep(2000);

      // Call both counters from the controller
      const refA = await cluster.system.getActorByName("counter-a");
      const refB = await cluster.system.getActorByName("counter-b");
      expect(refA).not.toBeNull();
      expect(refB).not.toBeNull();

      const valueA = await refA!.call({ method: "get", args: [] });
      const valueB = await refB!.call({ method: "get", args: [] });
      expect(valueA).toBe(100);
      expect(valueB).toBe(200);

      // Node lookup
      const found = cluster.node(cluster.nodes[0].nodeId);
      expect(found).toBe(cluster.nodes[0]);
      expect(() => cluster.node("non-existent")).toThrow(
        "Node not found: non-existent",
      );
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  // ── Node Lifecycle ─────────────────────────────────────────────

  it("should detect graceful node shutdown", { timeout: 90000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({ size: 2, timeout: 30000 });
    try {
      const membersBefore = cluster.system.cluster.getMembers();
      expect(membersBefore.length).toBe(3);

      // Gracefully shut down node 0
      await cluster.nodes[0].shutdown();

      // Wait for gossip to detect the departure (~1-3s for graceful leave)
      await sleep(5000);

      const membersAfter = cluster.system.cluster.getMembers();
      // Should be down to 2 members (controller + node 1)
      expect(membersAfter.length).toBe(2);
      expect(membersAfter).not.toContain(cluster.nodes[0].nodeId);
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  it("should detect node crash via SIGKILL", { timeout: 90000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({ size: 2, timeout: 30000 });
    try {
      const membersBefore = cluster.system.cluster.getMembers();
      expect(membersBefore.length).toBe(3);

      // Crash node 0 with SIGKILL (no graceful shutdown)
      cluster.nodes[0].kill("SIGKILL");

      // Gossip failure detection takes longer:
      // gossipIntervalMs=1000, failureTimeoutMs=5000, maxMissedHeartbeats=3
      // Typically ~5-8 seconds. Give 15s to be safe.
      await sleep(15000);

      const membersAfter = cluster.system.cluster.getMembers();
      // Should be down to 2 members (controller + node 1)
      expect(membersAfter.length).toBe(2);
      expect(membersAfter).not.toContain(cluster.nodes[0].nodeId);
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  // ── Teardown ───────────────────────────────────────────────────

  it("should support idempotent teardown and teardown after crash", { timeout: 90000, retry: 2 }, async () => {
    // Test 1: Idempotent teardown
    const cluster1 = await TestCluster.create({ size: 1, timeout: 30000 });
    await cluster1.teardown();
    await cluster1.teardown(); // should be no-op
    await cluster1.teardown(); // should be no-op
    await sleep(3000);

    // Test 2: Teardown after crash
    const cluster2 = await TestCluster.create({ size: 1, timeout: 30000 });
    cluster2.nodes[0].kill("SIGKILL");
    await sleep(500);
    // Teardown should succeed even though node is already dead
    await cluster2.teardown();
    await sleep(3000);
  });
});
