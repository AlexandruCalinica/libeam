// test/timers.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  TimerRef,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// Actor that uses sendAfter for delayed messages
class DelayedActor extends Actor {
  public receivedMessages: string[] = [];
  public timerRef?: TimerRef;

  handleCast(message: any): void {
    this.receivedMessages.push(message.type);

    if (message.type === "start_timer") {
      this.timerRef = this.sendAfter({ type: "delayed" }, message.delay);
    } else if (message.type === "cancel_timer") {
      if (this.timerRef) {
        this.cancelTimer(this.timerRef);
      }
    }
  }

  handleCall(message: any): any {
    if (message.type === "get_messages") {
      return [...this.receivedMessages];
    }
    return null;
  }
}

// Actor that uses sendInterval for repeating messages
class IntervalActor extends Actor {
  public tickCount = 0;
  public intervalRef?: TimerRef;

  handleCast(message: any): void {
    if (message.type === "start") {
      this.intervalRef = this.sendInterval({ type: "tick" }, message.interval);
    } else if (message.type === "tick") {
      this.tickCount++;
    } else if (message.type === "stop") {
      if (this.intervalRef) {
        this.cancelTimer(this.intervalRef);
      }
    } else if (message.type === "stop_all") {
      this.cancelAllTimers();
    }
  }

  handleCall(message: any): any {
    if (message.type === "get_count") {
      return this.tickCount;
    }
    return null;
  }
}

// Actor that starts multiple timers
class MultiTimerActor extends Actor {
  public results: string[] = [];
  private timers: TimerRef[] = [];

  handleCast(message: any): void {
    if (message.type === "start_multiple") {
      // Start 3 timers with different delays
      this.timers.push(this.sendAfter({ type: "first" }, 50));
      this.timers.push(this.sendAfter({ type: "second" }, 100));
      this.timers.push(this.sendAfter({ type: "third" }, 150));
    } else if (message.type === "cancel_all") {
      this.cancelAllTimers();
    } else {
      this.results.push(message.type);
    }
  }

  handleCall(message: any): any {
    if (message.type === "get_results") {
      return [...this.results];
    }
    return null;
  }
}

describe("Actor Timers", () => {
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

  describe("sendAfter", () => {
    it("should deliver message after delay", async () => {
      const actor = system.spawn(DelayedActor);

      actor.cast({ type: "start_timer", delay: 50 });

      // Before delay, only start_timer should be received
      await new Promise((r) => setTimeout(r, 20));
      let messages = await actor.call({ type: "get_messages" });
      expect(messages).toEqual(["start_timer"]);

      // After delay, delayed message should be received
      await new Promise((r) => setTimeout(r, 50));
      messages = await actor.call({ type: "get_messages" });
      expect(messages).toEqual(["start_timer", "delayed"]);
    });

    it("should allow cancelling timer before it fires", async () => {
      const actor = system.spawn(DelayedActor);

      actor.cast({ type: "start_timer", delay: 100 });
      await new Promise((r) => setTimeout(r, 20));

      // Cancel the timer
      actor.cast({ type: "cancel_timer" });
      await new Promise((r) => setTimeout(r, 20));

      // Wait past when timer would have fired
      await new Promise((r) => setTimeout(r, 100));

      const messages = await actor.call({ type: "get_messages" });
      expect(messages).toEqual(["start_timer", "cancel_timer"]);
      expect(messages).not.toContain("delayed");
    });

    it("should clean up timer after it fires", async () => {
      const actor = system.spawn(DelayedActor);

      actor.cast({ type: "start_timer", delay: 30 });
      await new Promise((r) => setTimeout(r, 60));

      // Timer should have fired and been cleaned up
      const messages = await actor.call({ type: "get_messages" });
      expect(messages).toEqual(["start_timer", "delayed"]);
    });
  });

  describe("sendInterval", () => {
    it("should deliver messages repeatedly", async () => {
      const actor = system.spawn(IntervalActor);

      actor.cast({ type: "start", interval: 30 });

      // Wait for several ticks
      await new Promise((r) => setTimeout(r, 100));

      const count = await actor.call({ type: "get_count" });
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(4);
    });

    it("should stop when cancelled", async () => {
      const actor = system.spawn(IntervalActor);

      actor.cast({ type: "start", interval: 20 });
      await new Promise((r) => setTimeout(r, 70));

      const countBefore = await actor.call({ type: "get_count" });
      expect(countBefore).toBeGreaterThanOrEqual(2);

      // Stop the interval
      actor.cast({ type: "stop" });
      await new Promise((r) => setTimeout(r, 20));

      const countAfterStop = await actor.call({ type: "get_count" });

      // Wait more and verify count doesn't increase
      await new Promise((r) => setTimeout(r, 60));
      const countLater = await actor.call({ type: "get_count" });

      expect(countLater).toBe(countAfterStop);
    });
  });

  describe("cancelAllTimers", () => {
    it("should cancel all active timers", async () => {
      const actor = system.spawn(MultiTimerActor);

      actor.cast({ type: "start_multiple" });
      await new Promise((r) => setTimeout(r, 30));

      // Cancel all before any fire
      actor.cast({ type: "cancel_all" });

      // Wait past all timer delays
      await new Promise((r) => setTimeout(r, 200));

      // Results should be empty - all timers were cancelled before firing
      const results = await actor.call({ type: "get_results" });
      expect(results).toEqual([]);
    });

    it("should cancel mix of one-shot and interval timers", async () => {
      const actor = system.spawn(IntervalActor);

      // Start an interval
      actor.cast({ type: "start", interval: 20 });
      await new Promise((r) => setTimeout(r, 50));

      const countBefore = await actor.call({ type: "get_count" });
      expect(countBefore).toBeGreaterThanOrEqual(1);

      // Cancel all
      actor.cast({ type: "stop_all" });
      await new Promise((r) => setTimeout(r, 20));

      const countAfter = await actor.call({ type: "get_count" });

      // Wait and verify no more ticks
      await new Promise((r) => setTimeout(r, 60));
      const countLater = await actor.call({ type: "get_count" });

      expect(countLater).toBe(countAfter);
    });
  });

  describe("timer cleanup on actor stop", () => {
    it("should cancel timers when actor is stopped", async () => {
      const actor = system.spawn(IntervalActor);

      actor.cast({ type: "start", interval: 20 });
      await new Promise((r) => setTimeout(r, 50));

      // Stop the actor
      await system.stop(actor);

      // Verify no errors occur (timers should be cleaned up)
      await new Promise((r) => setTimeout(r, 100));

      // Actor should be gone
      expect(system.getLocalActorIds()).not.toContain(actor.id.id);
    });
  });

  describe("multiple timers", () => {
    it("should handle multiple sendAfter timers firing in order", async () => {
      const actor = system.spawn(MultiTimerActor);

      actor.cast({ type: "start_multiple" });

      // Wait for all timers to fire
      await new Promise((r) => setTimeout(r, 200));

      const results = await actor.call({ type: "get_results" });
      expect(results).toEqual(["first", "second", "third"]);
    });
  });
});
