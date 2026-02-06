// test/zeromq_transport.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ZeroMQTransport,
  Actor,
  ActorSystem,
  ActorId,
  Cluster,
  RegistrySync,
  GossipRegistry,
  DistributedCluster,
} from "../src";
import * as net from "net";

// Helper to find an available TCP port
async function findAvailableTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", (err) => {
      server.close();
      reject(err);
    });
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

describe("ZeroMQTransport", () => {
  let port1: number;
  let port2: number;
  let transport1: ZeroMQTransport;
  let transport2: ZeroMQTransport;

  beforeEach(async () => {
    // Allocate 4 separate ports to avoid conflicts
    port1 = await findAvailableTcpPort();
    const pubPort1 = await findAvailableTcpPort();
    port2 = await findAvailableTcpPort();
    const pubPort2 = await findAvailableTcpPort();

    transport1 = new ZeroMQTransport({
      nodeId: "node1",
      rpcPort: port1,
      pubPort: pubPort1,
      bindAddress: "127.0.0.1",
    });

    transport2 = new ZeroMQTransport({
      nodeId: "node2",
      rpcPort: port2,
      pubPort: pubPort2,
      bindAddress: "127.0.0.1",
    });

    await transport1.connect();
    await transport2.connect();

    // Wire the transports together
    transport1.updatePeers([["node2", `tcp://127.0.0.1:${port2}`]]);
    transport2.updatePeers([["node1", `tcp://127.0.0.1:${port1}`]]);
  });

  afterEach(async () => {
    await transport1.disconnect();
    await transport2.disconnect();
  });

  it("should allow publish and subscribe", async () => {
    const topic = "test-topic";
    const message = { hello: "world" };

    const received = new Promise<any>((resolve) => {
      transport2.subscribe(topic, (msg) => {
        resolve(msg);
      });
    });

    // Allow time for subscription to be established
    await new Promise((r) => setTimeout(r, 100));

    await transport1.publish(topic, message);

    await expect(received).resolves.toEqual(message);
  });

  it("should allow request and respond", async () => {
    const requestMessage = { type: "get-data" };
    const expectedResponse = { data: "here is your data" };

    // Set up the responder first
    transport2.onRequest(async (msg) => {
      if (msg.type === "get-data") {
        return expectedResponse;
      }
      return { error: "unknown request" };
    });

    // Allow time for the responder to be ready
    await new Promise((r) => setTimeout(r, 100));

    // Make the request and verify the response
    const response = await transport1.request("node2", requestMessage, 5000);

    expect(response).toEqual(expectedResponse);
  });
});

// --- Full ActorSystem integration with real ZeroMQ ---

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

/**
 * Mock cluster for ZeroMQ integration tests.
 */
class MockCluster implements Cluster {
  private members: string[] = [];

  constructor(public readonly nodeId: string) {
    this.members = [nodeId];
  }

  addMember(nodeId: string): void {
    if (!this.members.includes(nodeId)) {
      this.members.push(nodeId);
    }
  }

  getMembers(): string[] {
    return [...this.members];
  }

  // Mock event emitter methods for RegistryGossip compatibility
  on(): this {
    return this;
  }
  emit(): boolean {
    return true;
  }
  getLivePeers(): Array<{ id: string; address: string }> {
    return this.members.map((id) => ({ id, address: "" }));
  }
}

describe("ZeroMQ ActorSystem Integration", () => {
  let transport1: ZeroMQTransport;
  let transport2: ZeroMQTransport;
  let system1: ActorSystem;
  let system2: ActorSystem;
  let registryGossip1: RegistrySync;
  let registryGossip2: RegistrySync;

  beforeEach(async () => {
    // Allocate ports
    const rpcPort1 = await findAvailableTcpPort();
    const pubPort1 = await findAvailableTcpPort();
    const rpcPort2 = await findAvailableTcpPort();
    const pubPort2 = await findAvailableTcpPort();

    // Create ZeroMQ transports
    transport1 = new ZeroMQTransport({
      nodeId: "node1",
      rpcPort: rpcPort1,
      pubPort: pubPort1,
      bindAddress: "127.0.0.1",
    });

    transport2 = new ZeroMQTransport({
      nodeId: "node2",
      rpcPort: rpcPort2,
      pubPort: pubPort2,
      bindAddress: "127.0.0.1",
    });

    await transport1.connect();
    await transport2.connect();

    // Wire transports together
    transport1.updatePeers([["node2", `tcp://127.0.0.1:${rpcPort2}`]]);
    transport2.updatePeers([["node1", `tcp://127.0.0.1:${rpcPort1}`]]);

    // Create mock clusters
    const cluster1 = new MockCluster("node1") as any;
    const cluster2 = new MockCluster("node2") as any;
    cluster1.addMember("node2");
    cluster2.addMember("node1");

    // Create registry gossip
    registryGossip1 = new RegistrySync("node1", transport1, cluster1);
    registryGossip2 = new RegistrySync("node2", transport2, cluster2);

    await registryGossip1.connect();
    await registryGossip2.connect();

    const registry1 = new GossipRegistry("node1", registryGossip1);
    const registry2 = new GossipRegistry("node2", registryGossip2);

    // Create actor systems
    system1 = new ActorSystem(cluster1, transport1, registry1);
    system2 = new ActorSystem(cluster2, transport2, registry2);

    system1.registerActorClass(CounterActor);
    system2.registerActorClass(CounterActor);

    await system1.start();
    await system2.start();
  });

  afterEach(async () => {
    await transport1.disconnect();
    await transport2.disconnect();
  });

  it("should route actor calls across nodes using real ZeroMQ", async () => {
    // Spawn actor on node1
    const counter = system1.spawn(CounterActor, { name: "counter" });

    // Wait for registry propagation (increased timeout for CI reliability)
    await new Promise((r) => setTimeout(r, 200));

    // Verify registry propagated
    const location = await registryGossip2.lookup("counter");
    expect(location?.nodeId).toBe("node1");

    // Create reference from node2
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
  });
});
