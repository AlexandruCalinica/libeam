import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  SystemShuttingDownError,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}

  getMembers(): string[] {
    return [this.nodeId];
  }
}

class SimpleActor extends Actor {
  handleCall(message: { type: string }): string | null {
    if (message.type === "ping") return "pong";
    return null;
  }

  handleCast(_message: unknown): void {}
}

class ParentActor extends Actor {
  handleCall(message: { type: string }): string {
    if (message.type === "spawnChild") {
      this.spawn(SimpleActor);
      return "spawned";
    }
    return "ok";
  }

  handleCast(_message: unknown): void {}
}

describe("ActorSystem drain", () => {
  let system: ActorSystem;
  const nodeId = "test-node";

  beforeEach(async () => {
    const cluster = new MockCluster(nodeId);
    const transport = new InMemoryTransport(nodeId);
    const registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    if (system.isRunning() || system.isDraining()) {
      await system.shutdown();
    }
  });

  it("isDraining() returns false initially", () => {
    expect(system.isDraining()).toBe(false);
  });

  it("drain() sets isDraining() to true", async () => {
    await system.drain();
    expect(system.isDraining()).toBe(true);
  });

  it("drain() rejects new spawns with SystemShuttingDownError", async () => {
    await system.drain();
    expect(() => system.spawn(SimpleActor)).toThrow(SystemShuttingDownError);
  });

  it("drain() rejects new spawnChild with SystemShuttingDownError", async () => {
    const parent = system.spawn(ParentActor);

    await system.drain();

    await expect(parent.call({ type: "spawnChild" })).rejects.toBeInstanceOf(
      SystemShuttingDownError,
    );
  });

  it("undrain() re-enables spawns", async () => {
    await system.drain();
    expect(() => system.spawn(SimpleActor)).toThrow(SystemShuttingDownError);

    system.undrain();
    const ref = system.spawn(SimpleActor);
    await expect(ref.call({ type: "ping" })).resolves.toBe("pong");
  });

  it("drain() without migration target just drains mailboxes", async () => {
    const a = system.spawn(SimpleActor, { name: "a" });
    const b = system.spawn(SimpleActor, { name: "b" });

    a.cast({ type: "noop" });
    b.cast({ type: "noop" });

    const result = await system.drain();

    expect(result.migrated).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.drained).toBe(2);
    await expect(a.call({ type: "ping" })).resolves.toBe("pong");
    await expect(b.call({ type: "ping" })).resolves.toBe("pong");
  });

  it("drain() is idempotent (calling twice returns {0,0,[]})", async () => {
    system.spawn(SimpleActor, { name: "worker" });

    const first = await system.drain();
    const second = await system.drain();

    expect(first.drained).toBe(1);
    expect(second).toEqual({ migrated: 0, drained: 0, failed: [] });
  });

  it("drain() returns correct DrainResult counts", async () => {
    system.spawn(SimpleActor, { name: "one" });
    system.spawn(SimpleActor, { name: "two" });
    system.spawn(SimpleActor, { name: "three" });

    const result = await system.drain();

    expect(result).toEqual({ migrated: 0, drained: 3, failed: [] });
  });

  it('getHealth() returns degraded with "System is draining" message when draining', async () => {
    system.spawn(SimpleActor);

    await system.drain();
    const health = system.getHealth();

    expect(health.status).toBe("degraded");
    expect(health.message).toBe("System is draining");
  });

  it("isRunning() returns true while draining", async () => {
    await system.drain();

    expect(system.isRunning()).toBe(true);
    expect(system.isDraining()).toBe(true);
  });
});
