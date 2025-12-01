// test/actor_system.test.ts

import {
  Actor,
  ActorSystem,
  ActorRef,
  InMemoryTransport,
  InMemoryRegistry,
  Cluster,
} from "../src";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * A simple in-memory cluster implementation for testing.
 */
class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}

  getMembers(): string[] {
    return [this.nodeId];
  }
}

// A simple actor for testing
class TestActor extends Actor {
  state: any;

  init(initialState: any) {
    this.state = initialState;
  }

  handleCall(message: any) {
    if (message.type === "get_state") {
      return this.state;
    }
    return "unknown call";
  }

  handleCast(message: any) {
    if (message.type === "set_state") {
      this.state = message.payload;
    }
  }
}

// An actor that is designed to crash
class CrashingActor extends Actor {
  handleCast(message: any) {
    if (message.type === "crash") {
      throw new Error("I was told to crash");
    }
  }
}

// An actor that tracks its lifecycle
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

// A parent actor that can spawn children
class ParentActor extends Actor {
  static terminationOrder: string[] = [];
  private childRefs: ActorRef[] = [];

  init(name: string) {
    (this as any).name = name;
  }

  terminate() {
    ParentActor.terminationOrder.push((this as any).name);
  }

  handleCall(message: any) {
    if (message.type === "spawn_child") {
      const childRef = this.spawn(ChildActor, { args: [message.childName] });
      this.childRefs.push(childRef);
      return childRef;
    }
    if (message.type === "get_children_count") {
      return this.getChildren().length;
    }
    if (message.type === "get_parent") {
      return this.context.parent;
    }
    return "unknown";
  }

  handleCast(message: any) {}
}

// A child actor for testing supervision trees
class ChildActor extends Actor {
  init(name: string) {
    (this as any).name = name;
  }

  terminate() {
    ParentActor.terminationOrder.push((this as any).name);
  }

  handleCall(message: any) {
    if (message.type === "get_parent") {
      return this.context.parent?.id.id;
    }
    if (message.type === "spawn_grandchild") {
      const grandchildRef = this.spawn(GrandchildActor, {
        args: [message.name],
      });
      return grandchildRef;
    }
    return "ok";
  }

  handleCast(message: any) {}
}

// A grandchild actor for deeper hierarchy testing
class GrandchildActor extends Actor {
  init(name: string) {
    (this as any).name = name;
  }

  terminate() {
    ParentActor.terminationOrder.push((this as any).name);
  }

  handleCall(message: any) {
    if (message.type === "get_parent") {
      return this.context.parent?.id.id;
    }
    return "ok";
  }

  handleCast(message: any) {}
}

describe("ActorSystem", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;
  let registry: InMemoryRegistry;
  let cluster: MockCluster;

  beforeEach(() => {
    transport = new InMemoryTransport("test-system");
    registry = new InMemoryRegistry();
    cluster = new MockCluster("test-system");
    system = new ActorSystem(cluster, transport, registry);
    system.start();
  });

  afterEach(async () => {
    // Clean up any remaining actors
  });

  it("should spawn an actor", () => {
    const actorRef = system.spawn(TestActor, { args: [{ started: true }] });
    expect(actorRef).toBeInstanceOf(ActorRef);
  });

  it("should allow call messages to an actor", async () => {
    const actorRef = system.spawn(TestActor, { args: [{ greeting: "hello" }] });
    const response = await actorRef.call({ type: "get_state" });
    expect(response).toEqual({ greeting: "hello" });
  });

  it("should allow cast messages to an actor", async () => {
    const actorRef = system.spawn(TestActor, { args: [{ greeting: "hello" }] });
    actorRef.cast({ type: "set_state", payload: { greeting: "world" } });

    // Give it a moment to process the cast
    await new Promise((r) => setTimeout(r, 100));

    const response = await actorRef.call({ type: "get_state" });
    expect(response).toEqual({ greeting: "world" });
  });

  it("should invoke the supervisor when an actor crashes", async () => {
    const supervisorSpy = vi.spyOn(console, "error");
    const actorRef = system.spawn(CrashingActor);

    actorRef.cast({ type: "crash" });

    // Give it a moment to crash and for the supervisor to react
    await new Promise((r) => setTimeout(r, 100));

    // Check that error was logged (structured logging format)
    expect(supervisorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Actor crashed"),
    );
  });

  describe("graceful shutdown", () => {
    it("should terminate all actors on shutdown", async () => {
      LifecycleActor.terminated = [];

      system.spawn(LifecycleActor, { args: ["actor1"] });
      system.spawn(LifecycleActor, { args: ["actor2"] });
      system.spawn(LifecycleActor, { args: ["actor3"] });

      expect(system.getLocalActorIds().length).toBe(3);
      expect(system.isRunning()).toBe(true);

      await system.shutdown();

      expect(system.isRunning()).toBe(false);
      expect(system.isShuttingDown()).toBe(true);
      expect(system.getLocalActorIds().length).toBe(0);
      expect(LifecycleActor.terminated).toHaveLength(3);
      expect(LifecycleActor.terminated).toContain("actor1");
      expect(LifecycleActor.terminated).toContain("actor2");
      expect(LifecycleActor.terminated).toContain("actor3");
    });

    it("should reject spawns during shutdown", async () => {
      await system.shutdown();

      expect(() => {
        system.spawn(TestActor, { args: [{}] });
      }).toThrow("spawn actors: system is shutting down");
    });

    it("should unregister named actors on shutdown", async () => {
      system.spawn(TestActor, { name: "named-actor", args: [{}] });

      // Verify it's registered
      const nodeId = await registry.lookup("named-actor");
      expect(nodeId).toBe("test-system");

      await system.shutdown();

      // Verify it's unregistered
      const nodeIdAfter = await registry.lookup("named-actor");
      expect(nodeIdAfter).toBeNull();
    });

    it("should be idempotent (multiple shutdown calls)", async () => {
      LifecycleActor.terminated = [];
      system.spawn(LifecycleActor, { args: ["actor1"] });

      await system.shutdown();
      await system.shutdown(); // Second call should be no-op

      expect(LifecycleActor.terminated).toHaveLength(1);
    });
  });

  describe("supervision trees", () => {
    beforeEach(() => {
      ParentActor.terminationOrder = [];
    });

    it("should allow an actor to spawn child actors", async () => {
      const parentRef = system.spawn(ParentActor, { args: ["parent"] });

      // Spawn a child through the parent
      const childRef = await parentRef.call({
        type: "spawn_child",
        childName: "child1",
      });

      expect(childRef).toBeDefined();
      expect(childRef.id).toBeDefined();

      // Verify parent knows about child
      const childrenCount = await parentRef.call({
        type: "get_children_count",
      });
      expect(childrenCount).toBe(1);
    });

    it("should set parent reference on child actors", async () => {
      const parentRef = system.spawn(ParentActor, { args: ["parent"] });

      const childRef = await parentRef.call({
        type: "spawn_child",
        childName: "child1",
      });

      // Verify child has reference to parent
      const parentId = await childRef.call({ type: "get_parent" });
      expect(parentId).toBe(parentRef.id.id);
    });

    it("should not set parent reference on root actors", async () => {
      const parentRef = system.spawn(ParentActor, { args: ["parent"] });

      const parent = await parentRef.call({ type: "get_parent" });
      expect(parent).toBeUndefined();
    });

    it("should cascade termination to children when parent stops", async () => {
      const parentRef = system.spawn(ParentActor, { args: ["parent"] });

      // Spawn multiple children
      await parentRef.call({ type: "spawn_child", childName: "child1" });
      await parentRef.call({ type: "spawn_child", childName: "child2" });

      // Verify actors exist
      expect(system.getLocalActorIds().length).toBe(3);

      // Stop the parent
      await system.stop(parentRef);

      // All actors should be terminated
      expect(system.getLocalActorIds().length).toBe(0);

      // Children should be terminated before parent
      expect(ParentActor.terminationOrder).toContain("child1");
      expect(ParentActor.terminationOrder).toContain("child2");
      expect(ParentActor.terminationOrder).toContain("parent");

      // Parent should be last
      expect(ParentActor.terminationOrder.indexOf("parent")).toBeGreaterThan(
        ParentActor.terminationOrder.indexOf("child1"),
      );
      expect(ParentActor.terminationOrder.indexOf("parent")).toBeGreaterThan(
        ParentActor.terminationOrder.indexOf("child2"),
      );
    });

    it("should support multi-level supervision trees", async () => {
      const parentRef = system.spawn(ParentActor, { args: ["root"] });

      // Spawn a child
      const childRef = await parentRef.call({
        type: "spawn_child",
        childName: "child",
      });

      // Spawn a grandchild through the child
      const grandchildRef = await childRef.call({
        type: "spawn_grandchild",
        name: "grandchild",
      });

      expect(grandchildRef).toBeDefined();

      // Verify grandchild has child as parent
      const grandchildParentId = await grandchildRef.call({
        type: "get_parent",
      });
      expect(grandchildParentId).toBe(childRef.id.id);

      // Verify all actors exist
      expect(system.getLocalActorIds().length).toBe(3);

      // Stop root - should cascade through entire tree
      await system.stop(parentRef);

      expect(system.getLocalActorIds().length).toBe(0);

      // Termination order: grandchild -> child -> root
      expect(ParentActor.terminationOrder).toEqual([
        "grandchild",
        "child",
        "root",
      ]);
    });

    it("should allow stopping individual children without affecting parent", async () => {
      const parentRef = system.spawn(ParentActor, { args: ["parent"] });

      const child1Ref = await parentRef.call({
        type: "spawn_child",
        childName: "child1",
      });
      await parentRef.call({ type: "spawn_child", childName: "child2" });

      expect(system.getLocalActorIds().length).toBe(3);

      // Stop just child1
      await system.stop(child1Ref);

      // Parent and child2 should still exist
      expect(system.getLocalActorIds().length).toBe(2);
      expect(ParentActor.terminationOrder).toEqual(["child1"]);

      // Parent's children count should be updated
      const childrenCount = await parentRef.call({
        type: "get_children_count",
      });
      expect(childrenCount).toBe(1);
    });

    it("should reject child spawns during shutdown", async () => {
      const parentRef = system.spawn(ParentActor, { args: ["parent"] });

      // Start shutdown
      const shutdownPromise = system.shutdown();

      // Try to spawn a child - should fail
      await expect(
        parentRef.call({ type: "spawn_child", childName: "child1" }),
      ).rejects.toThrow();

      await shutdownPromise;
    });
  });
});
