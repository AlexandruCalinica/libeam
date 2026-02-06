import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  Agent,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

describe("Agent", () => {
  let system: ActorSystem;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    const transport = new InMemoryTransport(cluster.nodeId);
    const registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("basic operations", () => {
    it("should start with initial state", async () => {
      const agent = Agent.start(system, 42);
      const value = await agent.get();
      expect(value).toBe(42);
      await agent.stop();
    });

    it("should update state", async () => {
      const agent = Agent.start(system, 0);

      await agent.update((n) => n + 1);
      expect(await agent.get()).toBe(1);

      await agent.update((n) => n + 10);
      expect(await agent.get()).toBe(11);

      await agent.stop();
    });

    it("should return new state from update", async () => {
      const agent = Agent.start(system, 5);

      const newValue = await agent.update((n) => n * 2);
      expect(newValue).toBe(10);

      await agent.stop();
    });

    it("should get and update atomically", async () => {
      const agent = Agent.start(system, 100);

      const oldValue = await agent.getAndUpdate((n) => n / 2);
      expect(oldValue).toBe(100);
      expect(await agent.get()).toBe(50);

      await agent.stop();
    });

    it("should cast without waiting", async () => {
      const agent = Agent.start(system, 0);

      // Fire-and-forget updates
      agent.cast((n) => n + 1);
      agent.cast((n) => n + 1);
      agent.cast((n) => n + 1);

      // Wait a bit for casts to process
      await new Promise((r) => setTimeout(r, 50));

      expect(await agent.get()).toBe(3);
      await agent.stop();
    });
  });

  describe("complex state types", () => {
    it("should work with objects", async () => {
      const agent = Agent.start(system, { count: 0, name: "test" });

      await agent.update((state) => ({ ...state, count: state.count + 1 }));
      const value = await agent.get();

      expect(value.count).toBe(1);
      expect(value.name).toBe("test");

      await agent.stop();
    });

    it("should work with arrays", async () => {
      const agent = Agent.start<string[]>(system, []);

      await agent.update((arr) => [...arr, "a"]);
      await agent.update((arr) => [...arr, "b"]);
      await agent.update((arr) => [...arr, "c"]);

      expect(await agent.get()).toEqual(["a", "b", "c"]);

      await agent.stop();
    });

    it("should work with Maps", async () => {
      const agent = Agent.start(system, new Map<string, number>());

      await agent.update((map) => new Map(map).set("key1", 1));
      await agent.update((map) => new Map(map).set("key2", 2));

      const result = await agent.get();
      expect(result.get("key1")).toBe(1);
      expect(result.get("key2")).toBe(2);

      await agent.stop();
    });
  });

  describe("getRef", () => {
    it("should return the underlying actor ref", async () => {
      const agent = Agent.start(system, 0);
      const ref = agent.getRef();

      expect(ref).toBeDefined();
      expect(ref.id).toBeDefined();

      await agent.stop();
    });
  });

  describe("named agents", () => {
    it("should support named agents", async () => {
      const agent = Agent.start(system, "hello", { name: "greeter" });

      const value = await agent.get();
      expect(value).toBe("hello");

      await agent.stop();
    });
  });

  describe("practical use cases", () => {
    it("should work as a counter", async () => {
      const counter = Agent.start(system, 0);

      await counter.update((n) => n + 1);
      await counter.update((n) => n + 1);
      await counter.update((n) => n - 1);

      expect(await counter.get()).toBe(1);

      await counter.stop();
    });

    it("should work as a cache", async () => {
      const cache = Agent.start(system, new Map<string, any>());

      // Set values
      await cache.update((m) => new Map(m).set("user:1", { name: "Alice" }));
      await cache.update((m) => new Map(m).set("user:2", { name: "Bob" }));

      // Get values
      const state = await cache.get();
      expect(state.get("user:1")).toEqual({ name: "Alice" });
      expect(state.get("user:2")).toEqual({ name: "Bob" });

      // Delete value
      await cache.update((m) => {
        const newMap = new Map(m);
        newMap.delete("user:1");
        return newMap;
      });

      expect((await cache.get()).has("user:1")).toBe(false);

      await cache.stop();
    });

    it("should work as a queue", async () => {
      const queue = Agent.start<number[]>(system, []);

      // Enqueue
      await queue.update((q) => [...q, 1]);
      await queue.update((q) => [...q, 2]);
      await queue.update((q) => [...q, 3]);

      // Dequeue (get first, remove it)
      const first = await queue.getAndUpdate((q) => q.slice(1));
      expect(first[0]).toBe(1);
      expect(await queue.get()).toEqual([2, 3]);

      await queue.stop();
    });
  });
});
