// test/rpc.test.ts

import {
  Actor,
  ActorSystem,
  ActorId,
  InMemoryRegistry,
  InMemoryTransport,
  Cluster,
} from '../src';

class GreeterActor extends Actor {
  handleCall(message: { type: 'greet'; name: string }) {
    if (message.type === 'greet') {
      return `Hello, ${message.name}!`;
    }
  }
}

describe('RPC', () => {
  let transport: InMemoryTransport;
  let node1: ActorSystem;
  let node2: ActorSystem;
  let cluster1: Cluster;
  let cluster2: Cluster;

  beforeEach(async () => {
    transport = new InMemoryTransport();
    await transport.connect();

    const registry1 = new InMemoryRegistry();
    const registry2 = new InMemoryRegistry(); // In a real scenario, this would be a shared registry

    // Simulate a shared registry by making them reference the same map
    // @ts-ignore
    registry2.registry = registry1.registry;

    cluster1 = new Cluster(transport, { nodeId: 'node1' });
    cluster2 = new Cluster(transport, { nodeId: 'node2' });

    node1 = new ActorSystem(cluster1, transport, registry1);
    node2 = new ActorSystem(cluster2, transport, registry2);

    await node1.start();
    await node2.start();
  });

  it('should allow sending a message to a remote actor', async () => {
    // 1. Spawn a named actor on node1
    const greeterRef = node1.spawn(GreeterActor, { name: 'greeter' });
    expect(greeterRef.id.name).toBe('greeter');

    // 2. On node2, create a reference to the remote actor
    // In a real app, the name and systemId might be discovered
    const remoteGreeterId = new ActorId('node1', greeterRef.id.id, 'greeter');
    const remoteGreeterRef = node2.getRef(remoteGreeterId);

    // 3. Send a message and get a reply
    const reply = await remoteGreeterRef.call({ type: 'greet', name: 'World' });

    expect(reply).toBe('Hello, World!');
  });
});
