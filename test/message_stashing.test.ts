import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
} from "../src";

/**
 * A simple in-memory cluster implementation for testing.
 */
class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}

  getMembers(): string[] {
    return [this.nodeId];
  }
}

/**
 * An actor that stashes messages until it's "ready".
 * Simulates async initialization.
 */
class InitializingActor extends Actor {
  public ready = false;
  public receivedMessages: string[] = [];
  public initDelay: number = 0;

  init(delay: number = 50) {
    this.initDelay = delay;
    // Simulate async initialization
    setTimeout(() => {
      this.ready = true;
      this.unstashAll();
    }, delay);
  }

  handleCast(message: any): void {
    if (!this.ready) {
      this.stash();
      return;
    }
    this.receivedMessages.push(message.value);
  }

  handleCall(message: any): any {
    if (message.type === "getMessages") {
      return this.receivedMessages;
    }
    if (message.type === "isReady") {
      return this.ready;
    }
    if (!this.ready) {
      this.stash();
      return; // Will be resolved when unstashed
    }
    return `processed: ${message.value}`;
  }
}

/**
 * An actor with state machine behavior.
 */
class StateMachineActor extends Actor {
  public state: "idle" | "processing" | "done" = "idle";
  public results: string[] = [];

  handleCast(message: any): void {
    if (message.type === "start") {
      this.state = "processing";
      this.unstashAll(); // Process any stashed work
    } else if (message.type === "finish") {
      this.state = "done";
    } else if (message.type === "work") {
      if (this.state !== "processing") {
        this.stash();
        return;
      }
      this.results.push(message.value);
    } else if (message.type === "reset") {
      this.state = "idle";
      this.clearStash();
    }
  }

  handleCall(message: any): any {
    if (message.type === "getState") {
      return this.state;
    }
    if (message.type === "getResults") {
      return this.results;
    }
    return null;
  }
}

/**
 * Actor that can unstash one at a time.
 */
class SelectiveUnstashActor extends Actor {
  public ready = false;
  public processed: string[] = [];

  handleCast(message: any): void {
    if (message.type === "setReady") {
      this.ready = true;
      // Unstash just one message
      this.unstash();
    } else if (message.type === "work") {
      if (!this.ready) {
        this.stash();
        return;
      }
      this.processed.push(message.value);
      // After processing one, go back to not ready
      this.ready = false;
    }
  }

  handleCall(message: any): any {
    if (message.type === "getProcessed") {
      return this.processed;
    }
    return null;
  }
}

describe("Message Stashing", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;
  let registry: LocalRegistry;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    transport = new InMemoryTransport("test-node");
    registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("basic stashing", () => {
    it("should stash cast messages until ready", async () => {
      const actor = system.spawn(InitializingActor, { args: [100] });

      // Send messages before actor is ready
      actor.cast({ value: "msg1" });
      actor.cast({ value: "msg2" });
      actor.cast({ value: "msg3" });

      // Wait a bit - messages should be stashed
      await new Promise((resolve) => setTimeout(resolve, 30));
      let messages = await actor.call({ type: "getMessages" });
      expect(messages).toHaveLength(0);

      // Wait for initialization to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Now messages should be processed
      messages = await actor.call({ type: "getMessages" });
      expect(messages).toEqual(["msg1", "msg2", "msg3"]);
    });

    it("should stash call messages until ready", async () => {
      const actor = system.spawn(InitializingActor, { args: [50] });

      // Start a call that will be stashed
      const resultPromise = actor.call({ type: "echo", value: "hello" }, 5000);

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Call should now resolve
      const result = await resultPromise;
      expect(result).toBe("processed: hello");
    });

    it("should preserve message order when unstashing", async () => {
      const actor = system.spawn(InitializingActor, { args: [50] });

      // Send messages in order
      actor.cast({ value: "first" });
      actor.cast({ value: "second" });
      actor.cast({ value: "third" });

      // Wait for initialization and processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      const messages = await actor.call({ type: "getMessages" });
      expect(messages).toEqual(["first", "second", "third"]);
    });
  });

  describe("state machine behavior", () => {
    it("should stash work until processing state", async () => {
      const actor = system.spawn(StateMachineActor);

      // Send work before starting
      actor.cast({ type: "work", value: "job1" });
      actor.cast({ type: "work", value: "job2" });

      await new Promise((resolve) => setTimeout(resolve, 20));
      let results = await actor.call({ type: "getResults" });
      expect(results).toHaveLength(0);

      // Start processing
      actor.cast({ type: "start" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Work should now be processed
      results = await actor.call({ type: "getResults" });
      expect(results).toEqual(["job1", "job2"]);
    });

    it("should clear stash on reset", async () => {
      const actor = system.spawn(StateMachineActor);

      // Send work while idle (will be stashed)
      actor.cast({ type: "work", value: "job1" });
      actor.cast({ type: "work", value: "job2" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Reset - should clear stash
      actor.cast({ type: "reset" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Now start processing
      actor.cast({ type: "start" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // No work should have been processed (stash was cleared)
      const results = await actor.call({ type: "getResults" });
      expect(results).toHaveLength(0);
    });
  });

  describe("selective unstashing", () => {
    it("should unstash one message at a time with unstash()", async () => {
      const actor = system.spawn(SelectiveUnstashActor);

      // Send multiple work items (will be stashed)
      actor.cast({ type: "work", value: "item1" });
      actor.cast({ type: "work", value: "item2" });
      actor.cast({ type: "work", value: "item3" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Set ready - should process one item
      actor.cast({ type: "setReady" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      let processed = await actor.call({ type: "getProcessed" });
      expect(processed).toEqual(["item1"]);

      // Set ready again - should process another
      actor.cast({ type: "setReady" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      processed = await actor.call({ type: "getProcessed" });
      expect(processed).toEqual(["item1", "item2"]);

      // And another
      actor.cast({ type: "setReady" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      processed = await actor.call({ type: "getProcessed" });
      expect(processed).toEqual(["item1", "item2", "item3"]);
    });
  });

  describe("mixed cast and call stashing", () => {
    it("should handle interleaved cast and call messages", async () => {
      const actor = system.spawn(InitializingActor, { args: [50] });

      // Send mixed messages
      actor.cast({ value: "cast1" });
      const call1Promise = actor.call({ type: "echo", value: "call1" }, 5000);
      actor.cast({ value: "cast2" });
      const call2Promise = actor.call({ type: "echo", value: "call2" }, 5000);

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      // All should resolve
      const [call1Result, call2Result] = await Promise.all([
        call1Promise,
        call2Promise,
      ]);
      expect(call1Result).toBe("processed: call1");
      expect(call2Result).toBe("processed: call2");

      const messages = await actor.call({ type: "getMessages" });
      expect(messages).toEqual(["cast1", "cast2"]);
    });
  });
});
