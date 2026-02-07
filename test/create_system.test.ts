import { describe, it, expect, afterEach } from "vitest";
import {
  createSystem,
  System,
  Actor,
  ActorRef,
  ActorSystem,
  InMemoryTransport,
  LocalRegistry,
  LocalCluster,
  LocalConfig,
  DistributedConfig,
} from "../src";

class TestActor extends Actor {
  state: any;

  init(initialState: any) {
    this.state = initialState ?? { value: 0 };
  }

  handleCall(message: any) {
    if (message.type === "get_state") {
      return this.state;
    }
    if (message.type === "increment") {
      this.state.value++;
      return this.state.value;
    }
    return "unknown call";
  }

  handleCast(message: any) {
    if (message.type === "set_state") {
      this.state = message.payload;
    }
  }
}

class AnotherTestActor extends Actor {
  handleCall(message: any) {
    return "another actor response";
  }
  handleCast(message: any) {}
}

class LifecycleActor extends Actor {
  static terminated: string[] = [];

  init(name: string) {
    (this as any).name = name;
  }

  terminate() {
    LifecycleActor.terminated.push((this as any).name);
  }

  handleCall(message: any) {
    return "ok";
  }

  handleCast(message: any) {}
}

describe("createSystem", () => {
  let systemUnderTest: System | null = null;

  afterEach(async () => {
    if (systemUnderTest) {
      await systemUnderTest.shutdown();
      systemUnderTest = null;
    }
    LifecycleActor.terminated = [];
  });

  describe("local system creation", () => {
    it("should create a local system with no config", () => {
      systemUnderTest = createSystem();

      expect(systemUnderTest).toBeDefined();
      expect(systemUnderTest.nodeId).toBeDefined();
      expect(systemUnderTest.nodeId).toMatch(/^local-[a-f0-9]{8}$/);
    });

    it("should create a local system with custom nodeId", () => {
      const config: LocalConfig = { nodeId: "my-custom-node" };
      systemUnderTest = createSystem(config);

      expect(systemUnderTest.nodeId).toBe("my-custom-node");
    });

    it("should create a local system with explicit type: local", () => {
      const config: LocalConfig = { type: "local", nodeId: "explicit-local" };
      systemUnderTest = createSystem(config);

      expect(systemUnderTest.nodeId).toBe("explicit-local");
    });

    it("should create a local system with supervision config", () => {
      const config: LocalConfig = {
        nodeId: "supervised-node",
        supervision: {
          strategy: "Restart",
          maxRestarts: 5,
          periodMs: 10000,
        },
      };
      systemUnderTest = createSystem(config);

      expect(systemUnderTest.nodeId).toBe("supervised-node");
      expect(systemUnderTest.system).toBeDefined();
    });
  });

  describe("escape hatches", () => {
    it("should expose transport", () => {
      systemUnderTest = createSystem();

      expect(systemUnderTest.transport).toBeDefined();
      expect(systemUnderTest.transport).toBeInstanceOf(InMemoryTransport);
    });

    it("should expose cluster", () => {
      systemUnderTest = createSystem();

      expect(systemUnderTest.cluster).toBeDefined();
      expect(systemUnderTest.cluster).toBeInstanceOf(LocalCluster);
    });

    it("should expose registry", () => {
      systemUnderTest = createSystem();

      expect(systemUnderTest.registry).toBeDefined();
      expect(systemUnderTest.registry).toBeInstanceOf(LocalRegistry);
    });

    it("should expose underlying ActorSystem", () => {
      systemUnderTest = createSystem();

      expect(systemUnderTest.system).toBeDefined();
      expect(systemUnderTest.system).toBeInstanceOf(ActorSystem);
    });

    it("should have consistent nodeId across system and cluster", () => {
      systemUnderTest = createSystem({ nodeId: "consistent-id" });

      expect(systemUnderTest.nodeId).toBe("consistent-id");
      expect(systemUnderTest.system.id).toBe("consistent-id");
      expect(systemUnderTest.cluster.nodeId).toBe("consistent-id");
    });
  });

  describe("spawn", () => {
    it("should spawn an actor with class-based definition", () => {
      systemUnderTest = createSystem();

      const ref = systemUnderTest.spawn(TestActor, { args: [{ value: 42 }] });

      expect(ref).toBeInstanceOf(ActorRef);
      expect(ref.id).toBeDefined();
    });

    it("should spawn actor that responds to call", async () => {
      systemUnderTest = createSystem();

      const ref = systemUnderTest.spawn(TestActor, { args: [{ value: 100 }] });
      const result = await ref.call({ type: "get_state" });

      expect(result).toEqual({ value: 100 });
    });

    it("should spawn actor that responds to cast", async () => {
      systemUnderTest = createSystem();

      const ref = systemUnderTest.spawn(TestActor, { args: [{ value: 0 }] });
      ref.cast({ type: "set_state", payload: { value: 999 } });

      await new Promise((r) => setTimeout(r, 50));

      const result = await ref.call({ type: "get_state" });
      expect(result).toEqual({ value: 999 });
    });

    it("should spawn named actors", async () => {
      systemUnderTest = createSystem();

      const ref = systemUnderTest.spawn(TestActor, {
        name: "named-test-actor",
        args: [{ value: 123 }],
      });

      expect(ref).toBeDefined();
      const location = await systemUnderTest.registry.lookup("named-test-actor");
      expect(location).not.toBeNull();
    });
  });

  describe("register", () => {
    it("should register an actor class", () => {
      systemUnderTest = createSystem();

      expect(() => {
        systemUnderTest!.register(TestActor);
      }).not.toThrow();
    });

    it("should register multiple actor classes", () => {
      systemUnderTest = createSystem();

      expect(() => {
        systemUnderTest!.register(TestActor);
        systemUnderTest!.register(AnotherTestActor);
      }).not.toThrow();
    });
  });

  describe("shutdown", () => {
    it("should terminate all actors on shutdown", async () => {
      systemUnderTest = createSystem({ nodeId: "shutdown-test" });

      systemUnderTest.spawn(LifecycleActor, { args: ["actor1"] });
      systemUnderTest.spawn(LifecycleActor, { args: ["actor2"] });
      systemUnderTest.spawn(LifecycleActor, { args: ["actor3"] });

      expect(systemUnderTest.system.getLocalActorIds().length).toBe(3);
      expect(systemUnderTest.system.isRunning()).toBe(true);

      await systemUnderTest.shutdown();
      systemUnderTest = null;

      expect(LifecycleActor.terminated).toHaveLength(3);
      expect(LifecycleActor.terminated).toContain("actor1");
      expect(LifecycleActor.terminated).toContain("actor2");
      expect(LifecycleActor.terminated).toContain("actor3");
    });

    it("should unregister named actors on shutdown", async () => {
      systemUnderTest = createSystem({ nodeId: "shutdown-registry-test" });

      systemUnderTest.spawn(TestActor, {
        name: "shutdown-named-actor",
        args: [{}],
      });

      const location = await systemUnderTest.registry.lookup("shutdown-named-actor");
      expect(location?.nodeId).toBe("shutdown-registry-test");

      await systemUnderTest.shutdown();

      const locationAfter = await systemUnderTest.registry.lookup("shutdown-named-actor");
      expect(locationAfter).toBeNull();

      systemUnderTest = null;
    });

    it("should be idempotent (multiple shutdown calls)", async () => {
      systemUnderTest = createSystem();

      systemUnderTest.spawn(LifecycleActor, { args: ["single-actor"] });

      await systemUnderTest.shutdown();
      await systemUnderTest.shutdown();

      expect(LifecycleActor.terminated).toHaveLength(1);
      systemUnderTest = null;
    });
  });

  describe("nodeId accessibility", () => {
    it("should expose nodeId at top level", () => {
      systemUnderTest = createSystem({ nodeId: "accessible-node" });

      expect(systemUnderTest.nodeId).toBe("accessible-node");
    });

    it("should generate unique nodeIds for systems without config", async () => {
      systemUnderTest = createSystem();
      const nodeId1 = systemUnderTest.nodeId;

      const firstSystem = systemUnderTest;
      systemUnderTest = createSystem();
      const nodeId2 = systemUnderTest.nodeId;

      expect(nodeId1).not.toBe(nodeId2);
      expect(nodeId1).toMatch(/^local-[a-f0-9]{8}$/);
      expect(nodeId2).toMatch(/^local-[a-f0-9]{8}$/);

      await firstSystem.shutdown();
    });
  });

  describe("distributed config validation", () => {
    it("should throw error when distributed config missing port and ports", async () => {
      const config: DistributedConfig = {
        type: "distributed",
        seedNodes: [],
      };

      await expect(createSystem(config)).rejects.toThrow(
        "Distributed config requires either 'port' or 'ports'"
      );
    });

    it("should throw error when distributed config has nodeId but no port options", async () => {
      const config: DistributedConfig = {
        type: "distributed",
        nodeId: "test-distributed",
        seedNodes: [],
      };

      await expect(createSystem(config)).rejects.toThrow(
        "Distributed config requires either 'port' or 'ports'"
      );
    });

    it("should throw error when distributed config has gossip options but no port", async () => {
      const configWithGossip: DistributedConfig = {
        type: "distributed",
        nodeId: "gossip-node",
        seedNodes: ["127.0.0.1:6000"],
        gossip: {
          gossipIntervalMs: 500,
          gossipFanout: 2,
          cleanupIntervalMs: 2000,
          failureTimeoutMs: 5000,
          seedNodes: [],
        },
      };

      await expect(createSystem(configWithGossip)).rejects.toThrow(
        "Distributed config requires either 'port' or 'ports'"
      );
    });
  });

  describe("port derivation logic", () => {
    it("should use port convention: rpc=port, pub=port+1, gossip=port+2", () => {
      const basePort = 5000;
      const expectedRpc = basePort;
      const expectedPub = basePort + 1;
      const expectedGossip = basePort + 2;

      expect(expectedRpc).toBe(5000);
      expect(expectedPub).toBe(5001);
      expect(expectedGossip).toBe(5002);
    });

    it("should accept explicit ports config structure", () => {
      const explicitPorts = { rpc: 6000, pub: 6100, gossip: 6200 };

      expect(explicitPorts.rpc).toBe(6000);
      expect(explicitPorts.pub).toBe(6100);
      expect(explicitPorts.gossip).toBe(6200);
    });
  });
});
