// test/distributed_integration.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  InMemoryTransport,
  DistributedCluster,
  GossipProtocol,
  GossipUDP,
  DistributedRegistry,
  ActorId,
} from "../src";
import { RegistrySync } from "../src/registry_sync";

class CounterActor extends Actor {
  private count = 0;

  handleCall(message: any): any {
    if (message.type === "increment") {
      this.count++;
      return { count: this.count };
    }
    if (message.type === "get") {
      return { count: this.count };
    }
    throw new Error(`Unknown message type: ${message.type}`);
  }
}

describe("Distributed Integration", () => {
  it("should work with decentralized registry and gossip cluster", async () => {
    // Setup two nodes with InMemoryTransport (for simplicity)
    const transport1 = new InMemoryTransport("node1");
    const transport2 = new InMemoryTransport("node2");

    // Wire transports together
    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);

    await transport1.connect();
    await transport2.connect();

    // Create mock gossip clusters (simplified for in-memory transport)
    // In real usage, these would be actual GossipProtocol instances with UDP
    const mockGossipProtocol1 = {
      getNodeId: () => "node1",
      start: async () => {},
      stop: async () => {},
      getLivePeers: () => [
        {
          id: "node1",
          address: "tcp://127.0.0.1:5001",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6001",
          lastUpdated: Date.now(),
        },
        {
          id: "node2",
          address: "tcp://127.0.0.1:5002",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6002",
          lastUpdated: Date.now(),
        },
      ],
      on: () => {},
      emit: () => {},
    } as any;

    const mockGossipProtocol2 = {
      getNodeId: () => "node2",
      start: async () => {},
      stop: async () => {},
      getLivePeers: () => [
        {
          id: "node1",
          address: "tcp://127.0.0.1:5001",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6001",
          lastUpdated: Date.now(),
        },
        {
          id: "node2",
          address: "tcp://127.0.0.1:5002",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6002",
          lastUpdated: Date.now(),
        },
      ],
      on: () => {},
      emit: () => {},
    } as any;

    const cluster1 = new DistributedCluster(mockGossipProtocol1);
    const cluster2 = new DistributedCluster(mockGossipProtocol2);

    // Create RegistryGossip instances
    const registryGossip1 = new RegistrySync("node1", transport1, cluster1);
    const registryGossip2 = new RegistrySync("node2", transport2, cluster2);

    await registryGossip1.connect();
    await registryGossip2.connect();

    const registry1 = new DistributedRegistry("node1", registryGossip1);
    const registry2 = new DistributedRegistry("node2", registryGossip2);

    // Create actor systems
    const system1 = new ActorSystem(cluster1 as any, transport1, registry1);
    const system2 = new ActorSystem(cluster2 as any, transport2, registry2);

    await system1.start();
    await system2.start();

    // Test 1: Spawn actor on node1, access from node2
    const counter = system1.spawn(CounterActor, { name: "counter" });

    // Wait for registry to propagate
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Node2 should be able to look up the actor
    const lookupResult = await registry2.lookup("counter");
    expect(lookupResult?.nodeId).toBe("node1");

    // Node2 creates a reference to the remote actor
    const remoteCounter = system2.getRef(
      new ActorId("node1", counter.id.id, "counter"),
    );

    // Call the remote actor from node2
    const result1 = await remoteCounter.call({ type: "increment" });
    expect(result1.count).toBe(1);

    const result2 = await remoteCounter.call({ type: "increment" });
    expect(result2.count).toBe(2);

    const result3 = await remoteCounter.call({ type: "get" });
    expect(result3.count).toBe(2);

    // Test 2: Verify registry cleanup
    await system1.stop(counter);

    // Wait for registry to propagate unregister
    await new Promise((resolve) => setTimeout(resolve, 50));

    const lookupAfterStop = await registry2.lookup("counter");
    expect(lookupAfterStop).toBeNull();

    // Cleanup
    await system1.stop(counter);
    await transport1.disconnect();
    await transport2.disconnect();
  });

  it("should handle vector clock conflicts in registry", async () => {
    const transport1 = new InMemoryTransport("node1");
    const transport2 = new InMemoryTransport("node2");

    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);

    await transport1.connect();
    await transport2.connect();

    const mockGossipProtocol1 = {
      getNodeId: () => "node1",
      start: async () => {},
      stop: async () => {},
      getLivePeers: () => [
        {
          id: "node1",
          address: "tcp://127.0.0.1:5001",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6001",
          lastUpdated: Date.now(),
        },
        {
          id: "node2",
          address: "tcp://127.0.0.1:5002",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6002",
          lastUpdated: Date.now(),
        },
      ],
      on: () => {},
      emit: () => {},
    } as any;

    const mockGossipProtocol2 = {
      getNodeId: () => "node2",
      start: async () => {},
      stop: async () => {},
      getLivePeers: () => [
        {
          id: "node1",
          address: "tcp://127.0.0.1:5001",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6001",
          lastUpdated: Date.now(),
        },
        {
          id: "node2",
          address: "tcp://127.0.0.1:5002",
          heartbeat: 1,
          generation: Date.now(),
          gossipAddress: "127.0.0.1:6002",
          lastUpdated: Date.now(),
        },
      ],
      on: () => {},
      emit: () => {},
    } as any;

    const cluster1 = new DistributedCluster(mockGossipProtocol1);
    const cluster2 = new DistributedCluster(mockGossipProtocol2);

    const registryGossip1 = new RegistrySync("node1", transport1, cluster1);
    const registryGossip2 = new RegistrySync("node2", transport2, cluster2);

    await registryGossip1.connect();
    await registryGossip2.connect();

    // Register the same actor name on both nodes (conflict)
    // The generation is now set internally using Date.now(), so later registration wins
    await registryGossip1.register("test-actor", "node1", "actor-1");
    await new Promise((resolve) => setTimeout(resolve, 10)); // Ensure different timestamps
    await registryGossip2.register("test-actor", "node2", "actor-2"); // Later registration wins

    // Wait for propagation
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Both nodes should converge to node2 (later registration)
    const lookup1 = await registryGossip1.lookup("test-actor");
    const lookup2 = await registryGossip2.lookup("test-actor");
    expect(lookup1?.nodeId).toBe("node2");
    expect(lookup2?.nodeId).toBe("node2");

    await transport1.disconnect();
    await transport2.disconnect();
  });
});
