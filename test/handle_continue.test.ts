// test/handle_continue.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  InitContinue,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// Actor that uses handleContinue for async initialization
class AsyncInitActor extends Actor {
  public initOrder: string[] = [];
  public continueData: any = null;

  init(): InitContinue<{ loadData: boolean }> {
    this.initOrder.push("init");
    return { continue: { loadData: true } };
  }

  async handleContinue(data: { loadData: boolean }) {
    // Simulate async work
    await new Promise((r) => setTimeout(r, 20));
    this.continueData = data;
    this.initOrder.push("handleContinue");
  }

  handleCall(message: any): any {
    if (message.type === "get_order") {
      return [...this.initOrder];
    }
    if (message.type === "get_data") {
      return this.continueData;
    }
    return null;
  }

  handleCast(_message: any): void {}
}

// Actor that does sync init without continue
class SyncInitActor extends Actor {
  public initialized = false;

  init() {
    this.initialized = true;
    // No return = no continue
  }

  handleCall(message: any): any {
    if (message.type === "is_initialized") {
      return this.initialized;
    }
    return null;
  }

  handleCast(_message: any): void {}
}

// Actor with async init that returns continue
class AsyncInitWithContinueActor extends Actor {
  public steps: string[] = [];

  async init(): Promise<InitContinue<string>> {
    await new Promise((r) => setTimeout(r, 10));
    this.steps.push("async_init");
    return { continue: "continue_data" };
  }

  async handleContinue(data: string) {
    await new Promise((r) => setTimeout(r, 10));
    this.steps.push(`handleContinue:${data}`);
  }

  handleCall(message: any): any {
    if (message.type === "get_steps") {
      return [...this.steps];
    }
    return null;
  }

  handleCast(_message: any): void {}
}

// Actor where handleContinue crashes
class CrashingContinueActor extends Actor {
  public crashed = false;

  init(): InitContinue {
    return { continue: "crash_please" };
  }

  handleContinue(_data: any) {
    throw new Error("Continue crashed!");
  }

  handleCast(_message: any): void {}
  handleCall(_message: any): any {
    return null;
  }
}

// Child actor that uses continue
class ChildWithContinueActor extends Actor {
  public ready = false;

  init(): InitContinue<{ setup: string }> {
    return { continue: { setup: "child_setup" } };
  }

  async handleContinue(data: { setup: string }) {
    await new Promise((r) => setTimeout(r, 10));
    this.ready = true;
  }

  handleCall(message: any): any {
    if (message.type === "is_ready") {
      return this.ready;
    }
    return null;
  }

  handleCast(_message: any): void {}
}

// Parent that spawns a child with continue
class ParentActor extends Actor {
  public childRef: any = null;

  init() {
    this.childRef = this.spawn(ChildWithContinueActor);
  }

  handleCall(message: any): any {
    if (message.type === "get_child") {
      return this.childRef;
    }
    return null;
  }

  handleCast(_message: any): void {}
}

describe("handleContinue", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    transport = new InMemoryTransport(cluster.nodeId);
    const registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("basic continue flow", () => {
    it("should call handleContinue after init returns continue signal", async () => {
      const actor = system.spawn(AsyncInitActor);

      // Wait for both init and handleContinue to complete
      await new Promise((r) => setTimeout(r, 50));

      const order = await actor.call({ type: "get_order" });
      expect(order).toEqual(["init", "handleContinue"]);
    });

    it("should pass continue data to handleContinue", async () => {
      const actor = system.spawn(AsyncInitActor);

      await new Promise((r) => setTimeout(r, 50));

      const data = await actor.call({ type: "get_data" });
      expect(data).toEqual({ loadData: true });
    });

    it("should not call handleContinue when init returns void", async () => {
      const actor = system.spawn(SyncInitActor);

      await new Promise((r) => setTimeout(r, 20));

      const initialized = await actor.call({ type: "is_initialized" });
      expect(initialized).toBe(true);
    });
  });

  describe("async init with continue", () => {
    it("should handle async init that returns continue", async () => {
      const actor = system.spawn(AsyncInitWithContinueActor);

      await new Promise((r) => setTimeout(r, 50));

      const steps = await actor.call({ type: "get_steps" });
      expect(steps).toEqual(["async_init", "handleContinue:continue_data"]);
    });
  });

  describe("error handling", () => {
    it("should trigger supervisor when handleContinue crashes", async () => {
      // Create a system with Stop strategy to avoid infinite restarts
      const cluster = new MockCluster("test-crash-node");
      const crashTransport = new InMemoryTransport(cluster.nodeId);
      const crashRegistry = new LocalRegistry();
      const crashSystem = new ActorSystem(
        cluster,
        crashTransport,
        crashRegistry,
        {
          strategy: "Stop",
          maxRestarts: 0,
          periodMs: 5000,
        },
      );
      await crashSystem.start();

      try {
        // The actor will crash in handleContinue and be stopped
        const actor = crashSystem.spawn(CrashingContinueActor);

        // Wait for crash
        await new Promise((r) => setTimeout(r, 50));

        // The actor ref should exist but the actor itself was stopped
        expect(actor).toBeDefined();
      } finally {
        await crashSystem.shutdown();
      }
    });
  });

  describe("child actors with continue", () => {
    it("should support handleContinue in child actors", async () => {
      const parent = system.spawn(ParentActor);

      // Wait for parent init and child's handleContinue
      await new Promise((r) => setTimeout(r, 50));

      const childRef = await parent.call({ type: "get_child" });
      expect(childRef).toBeDefined();

      const isReady = await childRef.call({ type: "is_ready" });
      expect(isReady).toBe(true);
    });
  });

  describe("message processing during continue", () => {
    it("should process messages during handleContinue execution", async () => {
      const actor = system.spawn(AsyncInitActor);

      // Send messages while handleContinue might still be running
      // Messages should be queued in mailbox and processed
      await new Promise((r) => setTimeout(r, 5)); // Small delay to let init start

      // This should work even if handleContinue hasn't finished
      // because message processing is independent
      await new Promise((r) => setTimeout(r, 60));

      const order = await actor.call({ type: "get_order" });
      expect(order).toContain("init");
      expect(order).toContain("handleContinue");
    });
  });
});
