// test/rpc.test.ts

import {
  Actor,
  ActorSystem,
  ActorId,
  LocalRegistry,
  InMemoryTransport,
  Cluster,
} from "../src";
import { describe, it, expect, beforeEach } from "vitest";

class GreeterActor extends Actor {
  handleCall(message: { type: "greet"; name: string }) {
    if (message.type === "greet") {
      return `Hello, ${message.name}!`;
    }
  }
}

/**
 * A mock cluster that can track multiple members.
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
}

describe("RPC", () => {
  let node1: ActorSystem;
  let node2: ActorSystem;
  let cluster1: MockCluster;
  let cluster2: MockCluster;

  beforeEach(async () => {
    const transport1 = new InMemoryTransport("node1");
    const transport2 = new InMemoryTransport("node2");

    // Wire transports together for multi-node testing
    transport1.setPeer("node2", transport2);
    transport2.setPeer("node1", transport1);

    await transport1.connect();
    await transport2.connect();

    const registry1 = new LocalRegistry();
    const registry2 = new LocalRegistry();

    // Simulate a shared registry by making them reference the same map
    // @ts-ignore
    registry2.registry = registry1.registry;

    cluster1 = new MockCluster("node1");
    cluster2 = new MockCluster("node2");

    // Each cluster knows about both nodes
    cluster1.addMember("node2");
    cluster2.addMember("node1");

    node1 = new ActorSystem(cluster1, transport1, registry1);
    node2 = new ActorSystem(cluster2, transport2, registry2);

    await node1.start();
    await node2.start();
  });

  it("should allow sending a message to a remote actor", async () => {
    // 1. Spawn a named actor on node1
    const greeterRef = node1.spawn(GreeterActor, { name: "greeter" });
    expect(greeterRef.id.name).toBe("greeter");

    // 2. On node2, create a reference to the remote actor
    const remoteGreeterId = new ActorId("node1", greeterRef.id.id, "greeter");
    const remoteGreeterRef = node2.getRef(remoteGreeterId);

    // 3. Send a message and get a reply
    const reply = await remoteGreeterRef.call({ type: "greet", name: "World" });

    expect(reply).toBe("Hello, World!");
  });
});
