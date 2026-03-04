import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSystem,
  createActor,
  System,
  Actor,
  ActorRef,
  NodeAgent,
} from "../src";
import type { NodeInfo } from "../src/orchestration/node_agent";

describe("NodeAgent", () => {
  let system: System;
  let agent: ReturnType<typeof system.spawn<[System], any, any>>;

  beforeEach(() => {
    system = createSystem({ nodeId: "test-node" });
    agent = system.spawn(NodeAgent, {
      name: "node-agent@test-node",
      args: [system],
    });
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("health", () => {
    it("should respond to ping", async () => {
      const result = await agent.call("ping");
      expect(result).toBe("pong");
    });

    it("should return node info", async () => {
      const info: NodeInfo = await agent.call("getNodeInfo");
      expect(info.nodeId).toBe("test-node");
      expect(info.uptime).toBeGreaterThan(0);
      expect(info.memoryUsage).toBeDefined();
      expect(info.memoryUsage.heapUsed).toBeGreaterThan(0);
      // At least the NodeAgent itself
      expect(info.actorCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("actor management with functional actors", () => {
    const Counter = createActor((ctx, self, initial: number) => {
      let count = initial;
      return self
        .onCall("get", () => count)
        .onCall("increment", () => ++count)
        .onCast("set", (v: number) => {
          count = v;
        });
    });

    it("should spawn a registered functional actor", async () => {
      // Register via NodeAgent
      await agent.call("registerActor", "Counter", Counter);

      const actorId = await agent.call("spawn", "Counter", {
        name: "my-counter",
        args: [10],
      });
      expect(actorId).toBeDefined();
      expect(typeof actorId).toBe("string");

      // Verify the actor is callable
      const ref = await system.getActorByName("my-counter");
      expect(ref).not.toBeNull();
      const value = await ref!.call({ method: "get", args: [] });
      expect(value).toBe(10);
    });

    it("should call an actor by name", async () => {
      await agent.call("registerActor", "Counter", Counter);
      await agent.call("spawn", "Counter", {
        name: "rpc-counter",
        args: [0],
      });

      const result = await agent.call("callActor", "rpc-counter", "get");
      expect(result).toBe(0);
    });

    it("should cast to an actor by name", async () => {
      await agent.call("registerActor", "Counter", Counter);
      await agent.call("spawn", "Counter", {
        name: "cast-counter",
        args: [0],
      });

      await agent.call("castActor", "cast-counter", "set", 42);

      // Give the cast time to process
      await new Promise((r) => setTimeout(r, 50));

      const result = await agent.call("callActor", "cast-counter", "get");
      expect(result).toBe(42);
    });

    it("should stop an actor by name", async () => {
      await agent.call("registerActor", "Counter", Counter);
      await agent.call("spawn", "Counter", {
        name: "stop-counter",
        args: [0],
      });

      const stopped = await agent.call("stopActor", "stop-counter");
      expect(stopped).toBe(true);

      // Actor should no longer be found
      const ref = await system.getActorByName("stop-counter");
      expect(ref).toBeNull();
    });

    it("should return false when stopping a non-existent actor", async () => {
      const stopped = await agent.call("stopActor", "nonexistent");
      expect(stopped).toBe(false);
    });

    it("should throw when calling a non-existent actor", async () => {
      await expect(
        agent.call("callActor", "nonexistent", "get"),
      ).rejects.toThrow("Actor not found: nonexistent");
    });

    it("should throw when spawning an unregistered class", async () => {
      await expect(
        agent.call("spawn", "UnknownActor", {}),
      ).rejects.toThrow("Actor class not registered: UnknownActor");
    });
  });

  describe("actor management with class-based actors", () => {
    class TestClassActor extends Actor {
      private value = 0;

      init(initial: number) {
        this.value = initial;
      }

      handleCall(message: any) {
        if (message.type === "get") return this.value;
        if (message.type === "increment") return ++this.value;
        return null;
      }

      handleCast(message: any) {
        if (message.type === "set") this.value = message.value;
      }
    }

    it("should spawn a registered class-based actor", async () => {
      system.register(TestClassActor);

      const actorId = await agent.call("spawn", "TestClassActor", {
        name: "class-actor",
        args: [5],
      });
      expect(actorId).toBeDefined();

      const ref = await system.getActorByName("class-actor");
      expect(ref).not.toBeNull();
      const value = await ref!.call({ type: "get" });
      expect(value).toBe(5);
    });
  });

  describe("getActorIds", () => {
    it("should return list of local actor IDs", async () => {
      const ids = await agent.call("getActorIds");
      // At minimum the NodeAgent itself should be in the list
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(ids)).toBe(true);
    });

    it("should include newly spawned actors", async () => {
      const Noop = createActor((ctx, self) => {
        return self.onCall("ping", () => "pong");
      });

      await agent.call("registerActor", "Noop", Noop);

      const idsBefore = await agent.call("getActorIds");
      await agent.call("spawn", "Noop", { name: "extra-actor" });
      const idsAfter = await agent.call("getActorIds");

      expect(idsAfter.length).toBe(idsBefore.length + 1);
    });
  });

  describe("shutdown", () => {
    it("should trigger system shutdown", async () => {
      // Create a separate system for this test so we don't break afterEach
      const shutdownSystem = createSystem({ nodeId: "shutdown-node" });
      const shutdownAgent = shutdownSystem.spawn(NodeAgent, {
        name: "node-agent@shutdown-node",
        args: [shutdownSystem],
      });

      // Verify system is running
      expect(shutdownSystem.system.isRunning()).toBe(true);

      await shutdownAgent.call("shutdown");

      // Give setImmediate time to fire
      await new Promise((r) => setTimeout(r, 100));

      expect(shutdownSystem.system.isRunning()).toBe(false);
    });
  });
});
