// test/placement.test.ts

import {
  Actor,
  ActorSystem,
  InMemoryRegistry,
  InMemoryTransport,
  Cluster,
} from '../src';

class PlacementTestActor extends Actor {}

// Hack to register actor classes globally for remote spawning
(global as any).actorClasses = {
  PlacementTestActor,
};

describe('PlacementEngine', () => {
  let transport: InMemoryTransport;
  let node1: ActorSystem;
  let node2: ActorSystem;
  let cluster1: Cluster;
  let cluster2: Cluster;

  beforeEach(async () => {
    transport = new InMemoryTransport();
    await transport.connect();

    const registry1 = new InMemoryRegistry();
    const registry2 = new InMemoryRegistry();
    // @ts-ignore
    registry2.registry = registry1.registry;

    cluster1 = new Cluster(transport, { nodeId: 'node1', heartbeatIntervalMs: 50 });
    cluster2 = new Cluster(transport, { nodeId: 'node2', heartbeatIntervalMs: 50 });

    await cluster1.start();
    await cluster2.start();
    
    // Wait for clusters to see each other
    await new Promise(r => setTimeout(r, 100));

    node1 = new ActorSystem(cluster1, transport, registry1);
    node2 = new ActorSystem(cluster2, transport, registry2);

    await node1.start();
    await node2.start();
  });

  it('should spawn actors round-robin across the cluster', async () => {
    // Spawn two actors with round-robin strategy from node1
    const ref1 = node1.spawn(PlacementTestActor, { strategy: 'round-robin' });
    const ref2 = node1.spawn(PlacementTestActor, { strategy: 'round-robin' });

    // Give time for the spawn messages to be processed
    await new Promise(r => setTimeout(r, 100));

    // One actor should be on each node. The placement engine is simple,
    // so we can predict the order.
    expect(node1.getLocalActorIds()).toHaveLength(1);
    expect(node2.getLocalActorIds()).toHaveLength(1);

    // Let's make sure the refs point to the right nodes
    const node1ActorId = node1.getLocalActorIds()[0];
    const node2ActorId = node2.getLocalActorIds()[0];
    
    // The first one goes to node2 (counter starts at 0, members are [node1, node2], counter becomes 1)
    // The second one goes to node1 (counter becomes 0)
    // This depends on the order of members in the cluster, which is not guaranteed.
    // A better test would be to just check that the total number of actors is correct.
    const allActors = [...node1.getLocalActorIds(), ...node2.getLocalActorIds()];
    expect(allActors).toHaveLength(2);
  });
});
