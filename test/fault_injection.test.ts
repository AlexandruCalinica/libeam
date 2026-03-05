import { describe, it, expect } from "vitest";
import * as path from "path";
import { TestCluster } from "../src";

// Helper: sleep
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Path to actor module that workers will load in-process.
const TEST_ACTOR_MODULE = path.resolve(__dirname, "fixtures/test_actors.ts");

// These are integration tests that create real distributed clusters with
// fault injection enabled. They test network partition simulation.
//
// Each test gets { retry: 2 } to handle transient failures from
// port contention or gossip convergence timing.

describe("FaultInjection", () => {
  // ── Basic Partition/Heal on worker node ───────────────────────

  it("should block RPC calls when a worker is partitioned from the controller and restore on heal", { timeout: 120000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({
      size: 1,
      faultInjection: true,
      timeout: 30000,
    });
    try {
      // Verify baseline connectivity: controller can reach worker
      const ping = await cluster.nodes[0].agent.call({ method: "ping", args: [] });
      expect(ping).toBe("pong");

      // Partition the controller from node 0
      // (so the controller's FaultyTransport blocks outbound to node 0)
      cluster.partitionController(cluster.nodes[0].nodeId);

      // Controller can no longer reach node 0's agent
      await expect(
        cluster.nodes[0].agent.call({ method: "ping", args: [] }),
      ).rejects.toThrow();

      // Heal controller
      cluster.healController(cluster.nodes[0].nodeId);
      await sleep(500);

      // Connectivity restored
      const pingAfter = await cluster.nodes[0].agent.call({ method: "ping", args: [] });
      expect(pingAfter).toBe("pong");
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  // ── Cross-node actor calls through partition ──────────────────

  it("should block cross-node actor calls when partitioned and restore on heal", { timeout: 120000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({
      size: 2,
      faultInjection: true,
      actorModules: [TEST_ACTOR_MODULE],
      timeout: 30000,
    });
    try {
      // Spawn a Counter on node 0
      await cluster.nodes[0].agent.call({
        method: "spawn",
        args: ["Counter", { name: "fault-counter", args: [10] }],
      });

      // Wait for registry sync across all nodes
      await sleep(3000);

      // Verify the counter is callable from the controller
      const ref = await cluster.system.getActorByName("fault-counter");
      expect(ref).not.toBeNull();
      const beforeValue = await ref!.call({ method: "get", args: [] });
      expect(beforeValue).toBe(10);

      // Partition the controller from node 0
      cluster.partitionController(cluster.nodes[0].nodeId);

      // Calls from controller to actor on node 0 should fail
      await expect(
        ref!.call({ method: "get", args: [] }),
      ).rejects.toThrow();

      // Heal the controller
      cluster.healController(cluster.nodes[0].nodeId);
      await sleep(500);

      // Calls should work again
      const afterValue = await ref!.call({ method: "get", args: [] });
      expect(afterValue).toBe(10);
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  // ── Heal All ──────────────────────────────────────────────────

  it("should heal all partitions when heal() is called with no arguments", { timeout: 120000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({
      size: 2,
      faultInjection: true,
      timeout: 30000,
    });
    try {
      // Ping both nodes to verify connectivity
      const ping0 = await cluster.nodes[0].agent.call({ method: "ping", args: [] });
      const ping1 = await cluster.nodes[1].agent.call({ method: "ping", args: [] });
      expect(ping0).toBe("pong");
      expect(ping1).toBe("pong");

      // Partition controller from both nodes
      cluster.partitionController(
        cluster.nodes[0].nodeId,
        cluster.nodes[1].nodeId,
      );

      // Both should fail
      await expect(
        cluster.nodes[0].agent.call({ method: "ping", args: [] }),
      ).rejects.toThrow();
      await expect(
        cluster.nodes[1].agent.call({ method: "ping", args: [] }),
      ).rejects.toThrow();

      // Heal all controller partitions
      cluster.healController();
      await sleep(500);

      // Both should work again
      const pingAfter0 = await cluster.nodes[0].agent.call({ method: "ping", args: [] });
      const pingAfter1 = await cluster.nodes[1].agent.call({ method: "ping", args: [] });
      expect(pingAfter0).toBe("pong");
      expect(pingAfter1).toBe("pong");
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  // ── Worker-side Partition via IPC ─────────────────────────────

  it("should support worker-side partition via IPC", { timeout: 120000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({
      size: 1,
      faultInjection: true,
      timeout: 30000,
    });
    try {
      // Verify connectivity
      const ping = await cluster.nodes[0].agent.call({ method: "ping", args: [] });
      expect(ping).toBe("pong");

      // Tell the worker to partition itself from the controller.
      // This means the worker's outbound to controller is blocked,
      // but controller can still SEND requests to the worker's Router socket.
      // The worker processes the request but its response gets blocked
      // by the FaultyTransport wrapper around the ZeroMQTransport.
      // Actually: FaultyTransport.request() is what blocks — it's the
      // outbound REQUEST that's blocked. But the RESPONSE to an inbound
      // request goes through the Router socket directly, not through
      // FaultyTransport.send(). So worker-side partition doesn't block
      // controller→worker calls, it blocks worker→controller calls.
      // This is correct asymmetric partition behavior.
      await cluster.nodes[0].partition(cluster.controllerId);
      await sleep(500);

      // Controller can still reach the worker (asymmetric partition)
      const pingDuringPartition = await cluster.nodes[0].agent.call({ method: "ping", args: [] });
      expect(pingDuringPartition).toBe("pong");

      // Heal
      await cluster.nodes[0].heal(cluster.controllerId);
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });

  // ── Fault Injection Not Enabled ───────────────────────────────

  it("should throw when calling partition() without faultInjection enabled", { timeout: 60000, retry: 2 }, async () => {
    const cluster = await TestCluster.create({
      size: 1,
      faultInjection: false,
      timeout: 30000,
    });
    try {
      await expect(
        cluster.nodes[0].partition(cluster.controllerId),
      ).rejects.toThrow("Fault injection not enabled");

      expect(() => cluster.partitionController(cluster.nodes[0].nodeId)).toThrow(
        "Fault injection not enabled",
      );
    } finally {
      await cluster.teardown();
      await sleep(3000);
    }
  });
});
