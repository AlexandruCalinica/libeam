// test/placement.test.ts

import {
  Actor,
  ActorSystem,
  LocalRegistry,
  InMemoryTransport,
  Cluster,
} from "../src";
import { describe, it, expect, beforeEach } from "vitest";

class PlacementTestActor extends Actor {}

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

describe("PlacementEngine", () => {
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
    // @ts-ignore
    registry2.registry = registry1.registry;

    cluster1 = new MockCluster("node1");
    cluster2 = new MockCluster("node2");

    // Each cluster knows about both nodes
    cluster1.addMember("node2");
    cluster2.addMember("node1");

    node1 = new ActorSystem(cluster1, transport1, registry1);
    node2 = new ActorSystem(cluster2, transport2, registry2);

    // Register actor classes on both nodes for remote spawning
    node1.registerActorClass(PlacementTestActor);
    node2.registerActorClass(PlacementTestActor);

    await node1.start();
    await node2.start();
  });

  it("should spawn actors round-robin across the cluster", async () => {
    // Spawn two actors with round-robin strategy from node1
    const ref1 = node1.spawn(PlacementTestActor, { strategy: "round-robin" });
    const ref2 = node1.spawn(PlacementTestActor, { strategy: "round-robin" });

    // Give time for the spawn messages to be processed
    await new Promise((r) => setTimeout(r, 100));

    // One actor should be on each node. The placement engine is simple,
    // so we can predict the order.
    expect(node1.getLocalActorIds()).toHaveLength(1);
    expect(node2.getLocalActorIds()).toHaveLength(1);

    // The total number of actors should be 2
    const allActors = [
      ...node1.getLocalActorIds(),
      ...node2.getLocalActorIds(),
    ];
    expect(allActors).toHaveLength(2);
  });
});
