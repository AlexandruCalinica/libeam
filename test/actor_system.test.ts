// test/actor_system.test.ts

import { Actor, ActorSystem, ActorRef, InMemoryTransport, InMemoryRegistry, Cluster } from '../src';
import { vi } from 'vitest';

// A simple actor for testing
class TestActor extends Actor {
  state: any;

  init(initialState: any) {
    this.state = initialState;
  }

  handleCall(message: any) {
    if (message.type === 'get_state') {
      return this.state;
    }
    return 'unknown call';
  }

  handleCast(message: any) {
    if (message.type === 'set_state') {
      this.state = message.payload;
    }
  }
}

// An actor that is designed to crash
class CrashingActor extends Actor {
  handleCast(message: any) {
    if (message.type === 'crash') {
      throw new Error('I was told to crash');
    }
  }
}

describe('ActorSystem', () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;
  let registry: InMemoryRegistry;
  let cluster: Cluster;

  beforeEach(() => {
    transport = new InMemoryTransport();
    registry = new InMemoryRegistry();
    cluster = new Cluster(transport, { nodeId: 'test-system' });
    system = new ActorSystem(cluster, transport, registry);
    system.start();
  });

  afterEach(async () => {
    // Clean up any remaining actors
  });

  it('should spawn an actor', () => {
    const actorRef = system.spawn(TestActor, { args: [{ started: true }] });
    expect(actorRef).toBeInstanceOf(ActorRef);
  });

  it('should allow call messages to an actor', async () => {
    const actorRef = system.spawn(TestActor, { args: [{ greeting: 'hello' }] });
    const response = await actorRef.call({ type: 'get_state' });
    expect(response).toEqual({ greeting: 'hello' });
  });

  it('should allow cast messages to an actor', async () => {
    const actorRef = system.spawn(TestActor, { args: [{ greeting: 'hello' }] });
    actorRef.cast({ type: 'set_state', payload: { greeting: 'world' } });

    // Give it a moment to process the cast
    await new Promise(r => setTimeout(r, 100));

    const response = await actorRef.call({ type: 'get_state' });
    expect(response).toEqual({ greeting: 'world' });
  });

  it('should invoke the supervisor when an actor crashes', async () => {
    const supervisorSpy = vi.spyOn(console, 'error');
    const actorRef = system.spawn(CrashingActor);

    actorRef.cast({ type: 'crash' });

    // Give it a moment to crash and for the supervisor to react
    await new Promise(r => setTimeout(r, 100));

    expect(supervisorSpy).toHaveBeenCalledWith(
      expect.stringContaining('crashed with error:'),
      expect.any(Error)
    );
  });
});
