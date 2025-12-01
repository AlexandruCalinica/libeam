// test/child_supervision.test.ts

import {
  Actor,
  ActorSystem,
  ActorRef,
  InMemoryTransport,
  InMemoryRegistry,
  Cluster,
  ChildSupervisionOptions,
} from "../src";
import { describe, it, expect, beforeEach, vi } from "vitest";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// Track restart events globally
const restartEvents: string[] = [];
const terminationEvents: string[] = [];

// A child actor that can crash on demand
class WorkerActor extends Actor {
  private name = "";

  init(name: string) {
    this.name = name;
    restartEvents.push(`init:${name}`);
  }

  terminate() {
    terminationEvents.push(`terminate:${this.name}`);
  }

  handleCall(message: any) {
    if (message.type === "get_name") {
      return this.name;
    }
    return "ok";
  }

  handleCast(message: any) {
    if (message.type === "crash") {
      throw new Error(`${this.name} crashed`);
    }
  }
}

// Parent with one-for-one strategy (default)
class OneForOneParent extends Actor {
  init() {
    restartEvents.push("init:parent");
  }

  terminate() {
    terminationEvents.push("terminate:parent");
  }

  handleCall(message: any) {
    if (message.type === "spawn_worker") {
      return this.spawn(WorkerActor, { args: [message.name] });
    }
    if (message.type === "get_children") {
      return this.getChildren();
    }
    return "ok";
  }

  handleCast(message: any) {}
}

// Parent with one-for-all strategy
class OneForAllParent extends Actor {
  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "one-for-all",
      maxRestarts: 3,
      periodMs: 5000,
    };
  }

  init() {
    restartEvents.push("init:parent");
  }

  terminate() {
    terminationEvents.push("terminate:parent");
  }

  handleCall(message: any) {
    if (message.type === "spawn_worker") {
      return this.spawn(WorkerActor, { args: [message.name] });
    }
    if (message.type === "get_children") {
      return this.getChildren();
    }
    return "ok";
  }

  handleCast(message: any) {}
}

// Parent with rest-for-one strategy
class RestForOneParent extends Actor {
  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "rest-for-one",
      maxRestarts: 3,
      periodMs: 5000,
    };
  }

  init() {
    restartEvents.push("init:parent");
  }

  terminate() {
    terminationEvents.push("terminate:parent");
  }

  handleCall(message: any) {
    if (message.type === "spawn_worker") {
      return this.spawn(WorkerActor, { args: [message.name] });
    }
    if (message.type === "get_children") {
      return this.getChildren();
    }
    return "ok";
  }

  handleCast(message: any) {}
}

describe("Child Supervision Strategies", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;
  let registry: InMemoryRegistry;
  let cluster: MockCluster;

  beforeEach(() => {
    // Clear tracking arrays
    restartEvents.length = 0;
    terminationEvents.length = 0;

    transport = new InMemoryTransport("test-system");
    registry = new InMemoryRegistry();
    cluster = new MockCluster("test-system");
    system = new ActorSystem(cluster, transport, registry);
    system.start();
  });

  describe("one-for-one strategy", () => {
    it("should only restart the crashed child", async () => {
      const parentRef = system.spawn(OneForOneParent);

      // Spawn three workers
      const worker1 = await parentRef.call({
        type: "spawn_worker",
        name: "worker1",
      });
      const worker2 = await parentRef.call({
        type: "spawn_worker",
        name: "worker2",
      });
      const worker3 = await parentRef.call({
        type: "spawn_worker",
        name: "worker3",
      });

      // Clear init events from spawning
      restartEvents.length = 0;
      terminationEvents.length = 0;

      // Crash worker2
      worker2.cast({ type: "crash" });

      // Wait for supervision to handle the crash
      await new Promise((r) => setTimeout(r, 200));

      // Only worker2 should have been restarted
      expect(restartEvents).toContain("init:worker2");
      expect(restartEvents).not.toContain("init:worker1");
      expect(restartEvents).not.toContain("init:worker3");

      // Parent should still have 3 children
      const children = await parentRef.call({ type: "get_children" });
      expect(children.length).toBe(3);
    });
  });

  describe("one-for-all strategy", () => {
    it("should restart all children when one crashes", async () => {
      const parentRef = system.spawn(OneForAllParent);

      // Spawn three workers
      const worker1 = await parentRef.call({
        type: "spawn_worker",
        name: "worker1",
      });
      await parentRef.call({ type: "spawn_worker", name: "worker2" });
      await parentRef.call({ type: "spawn_worker", name: "worker3" });

      // Clear init events from spawning
      restartEvents.length = 0;
      terminationEvents.length = 0;

      // Crash worker1
      worker1.cast({ type: "crash" });

      // Wait for supervision to handle the crash
      await new Promise((r) => setTimeout(r, 200));

      // All workers should have been terminated and restarted
      expect(terminationEvents).toContain("terminate:worker1");
      expect(terminationEvents).toContain("terminate:worker2");
      expect(terminationEvents).toContain("terminate:worker3");

      expect(restartEvents).toContain("init:worker1");
      expect(restartEvents).toContain("init:worker2");
      expect(restartEvents).toContain("init:worker3");

      // Parent should still have 3 children
      const children = await parentRef.call({ type: "get_children" });
      expect(children.length).toBe(3);
    });

    it("should restart children in original spawn order", async () => {
      const parentRef = system.spawn(OneForAllParent);

      // Spawn workers in order
      const worker1 = await parentRef.call({
        type: "spawn_worker",
        name: "w1",
      });
      await parentRef.call({ type: "spawn_worker", name: "w2" });
      await parentRef.call({ type: "spawn_worker", name: "w3" });

      restartEvents.length = 0;

      // Crash worker1
      worker1.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 200));

      // Check restart order (init events should be in spawn order)
      const initEvents = restartEvents.filter((e) => e.startsWith("init:"));
      expect(initEvents).toEqual(["init:w1", "init:w2", "init:w3"]);
    });
  });

  describe("rest-for-one strategy", () => {
    it("should restart crashed child and all children after it", async () => {
      const parentRef = system.spawn(RestForOneParent);

      // Spawn workers in order: w1, w2, w3
      await parentRef.call({ type: "spawn_worker", name: "w1" });
      const worker2 = await parentRef.call({
        type: "spawn_worker",
        name: "w2",
      });
      await parentRef.call({ type: "spawn_worker", name: "w3" });

      restartEvents.length = 0;
      terminationEvents.length = 0;

      // Crash w2 - should restart w2 and w3 (but not w1)
      worker2.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 200));

      // w1 should NOT be terminated or restarted
      expect(terminationEvents).not.toContain("terminate:w1");
      expect(restartEvents).not.toContain("init:w1");

      // w2 and w3 should be terminated and restarted
      expect(terminationEvents).toContain("terminate:w2");
      expect(terminationEvents).toContain("terminate:w3");
      expect(restartEvents).toContain("init:w2");
      expect(restartEvents).toContain("init:w3");

      // Parent should still have 3 children
      const children = await parentRef.call({ type: "get_children" });
      expect(children.length).toBe(3);
    });

    it("should only restart crashed child if it's the last one", async () => {
      const parentRef = system.spawn(RestForOneParent);

      await parentRef.call({ type: "spawn_worker", name: "w1" });
      await parentRef.call({ type: "spawn_worker", name: "w2" });
      const worker3 = await parentRef.call({
        type: "spawn_worker",
        name: "w3",
      });

      restartEvents.length = 0;
      terminationEvents.length = 0;

      // Crash w3 (last child) - only w3 should restart
      worker3.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 200));

      expect(terminationEvents).toEqual(["terminate:w3"]);
      expect(restartEvents).toEqual(["init:w3"]);
    });

    it("should restart all children if first one crashes", async () => {
      const parentRef = system.spawn(RestForOneParent);

      const worker1 = await parentRef.call({
        type: "spawn_worker",
        name: "w1",
      });
      await parentRef.call({ type: "spawn_worker", name: "w2" });
      await parentRef.call({ type: "spawn_worker", name: "w3" });

      restartEvents.length = 0;
      terminationEvents.length = 0;

      // Crash w1 (first child) - all should restart
      worker1.cast({ type: "crash" });
      await new Promise((r) => setTimeout(r, 200));

      expect(terminationEvents).toContain("terminate:w1");
      expect(terminationEvents).toContain("terminate:w2");
      expect(terminationEvents).toContain("terminate:w3");

      expect(restartEvents).toContain("init:w1");
      expect(restartEvents).toContain("init:w2");
      expect(restartEvents).toContain("init:w3");
    });
  });

  describe("max restarts", () => {
    it("should stop child after exceeding max restarts", async () => {
      // Create a parent with low max restarts
      class LimitedParent extends Actor {
        childSupervision(): ChildSupervisionOptions {
          return {
            strategy: "one-for-one",
            maxRestarts: 2,
            periodMs: 5000,
          };
        }

        handleCall(message: any) {
          if (message.type === "spawn_worker") {
            return this.spawn(WorkerActor, { args: [message.name] });
          }
          if (message.type === "get_children") {
            return this.getChildren();
          }
          return "ok";
        }
        handleCast() {}
      }

      const parentRef = system.spawn(LimitedParent);
      await parentRef.call({
        type: "spawn_worker",
        name: "crasher",
      });

      // Helper to crash the current child (gets new ref after restart)
      const crashCurrentChild = async () => {
        const children = await parentRef.call({ type: "get_children" });
        if (children.length > 0) {
          children[0].cast({ type: "crash" });
        }
      };

      // Crash multiple times to exceed limit (2 restarts allowed = 3 crashes to stop)
      await crashCurrentChild();
      await new Promise((r) => setTimeout(r, 150));

      await crashCurrentChild();
      await new Promise((r) => setTimeout(r, 150));

      await crashCurrentChild();
      await new Promise((r) => setTimeout(r, 150));

      // After 3 crashes with max 2 restarts, child should be stopped
      const children = await parentRef.call({ type: "get_children" });
      expect(children.length).toBe(0);
    });
  });
});
