import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LocalRegistry,
  InfoMessage,
  TimeoutMessage,
} from "../src";

/**
 * Helper to poll for a condition with timeout.
 * More reliable than fixed waits under CPU load.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeout = 500, interval = 10 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// Simple actor that tracks timeout messages
class TimeoutTrackingActor extends Actor {
  public timeouts: TimeoutMessage[] = [];
  public timeoutCount = 0;

  init() {
    // Enable idle timeout via message
  }

  handleCast(message: any) {
    if (message.type === "setIdleTimeout") {
      this.setIdleTimeout(message.timeoutMs);
    } else if (message.type === "ping") {
      // Just a keep-alive message
    } else if (message.type === "disableTimeout") {
      this.setIdleTimeout(0);
    }
  }

  handleCall(message: any) {
    if (message.type === "getTimeouts") {
      return this.timeouts;
    } else if (message.type === "getTimeoutCount") {
      return this.timeoutCount;
    } else if (message.type === "getIdleTimeout") {
      return this.getIdleTimeout();
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      this.timeouts.push(message);
      this.timeoutCount++;
    }
  }
}

// Actor that sets idle timeout in init
class InitTimeoutActor extends Actor {
  public timeouts: TimeoutMessage[] = [];

  init() {
    this.setIdleTimeout(50); // 50ms timeout
  }

  handleCast(_message: any) {
    // Any message resets the timeout
  }

  handleCall(message: any) {
    if (message.type === "getTimeouts") {
      return this.timeouts;
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      this.timeouts.push(message);
    }
  }
}

// Actor that stops itself on timeout
class SelfStoppingActor extends Actor {
  public stopped = false;

  init() {
    this.setIdleTimeout(50);
  }

  handleCast(_message: any) {
    // Activity
  }

  handleCall(message: any) {
    if (message.type === "isStopped") {
      return this.stopped;
    }
    return null;
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      this.stopped = true;
      this.context.system.stop(this.self);
    }
  }
}

describe("Actor Idle Timeout", () => {
  let system: ActorSystem;
  let cluster: MockCluster;

  beforeEach(async () => {
    cluster = new MockCluster("test-node");
    const transport = new InMemoryTransport(cluster.nodeId);
    const registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry, {
      strategy: "Stop",
      maxRestarts: 0,
      periodMs: 5000,
    });
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("basic functionality", () => {
    it("should receive timeout message after idle period", async () => {
      const ref = system.spawn(TimeoutTrackingActor);
      ref.cast({ type: "setIdleTimeout", timeoutMs: 50 });

      // Wait long enough for 50ms timeout to fire under CPU load
      await new Promise((resolve) => setTimeout(resolve, 200));

      const timeouts = await ref.call({ type: "getTimeouts" });
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
      expect(timeouts[0].type).toBe("timeout");
      expect(timeouts[0].idleMs).toBeGreaterThanOrEqual(50);
    });

    it("should reset timeout when message is received", async () => {
      const ref = system.spawn(TimeoutTrackingActor);
      ref.cast({ type: "setIdleTimeout", timeoutMs: 80 });

      // Send ping messages every 30ms to prevent timeout
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        ref.cast({ type: "ping" });
      }

      // Check that no timeouts occurred
      const count = await ref.call({ type: "getTimeoutCount" });
      expect(count).toBe(0);
    });

    it("should allow disabling timeout by setting to 0", async () => {
      const ref = system.spawn(TimeoutTrackingActor);
      ref.cast({ type: "setIdleTimeout", timeoutMs: 50 });

      // Wait a bit but disable before timeout
      await new Promise((resolve) => setTimeout(resolve, 20));
      ref.cast({ type: "disableTimeout" });

      // Wait past when timeout would have fired
      await new Promise((resolve) => setTimeout(resolve, 100));

      const count = await ref.call({ type: "getTimeoutCount" });
      expect(count).toBe(0);
    });

    it("should return current timeout via getIdleTimeout", async () => {
      const ref = system.spawn(TimeoutTrackingActor);

      // Initially 0
      let timeout = await ref.call({ type: "getIdleTimeout" });
      expect(timeout).toBe(0);

      // Set timeout
      ref.cast({ type: "setIdleTimeout", timeoutMs: 100 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      timeout = await ref.call({ type: "getIdleTimeout" });
      expect(timeout).toBe(100);

      // Disable
      ref.cast({ type: "disableTimeout" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      timeout = await ref.call({ type: "getIdleTimeout" });
      expect(timeout).toBe(0);
    });
  });

  describe("timeout in init", () => {
    it("should support setting idle timeout in init()", async () => {
      const ref = system.spawn(InitTimeoutActor);

      // Wait long enough for 50ms timeout to fire under CPU load (calls reset idle timer)
      await new Promise((resolve) => setTimeout(resolve, 200));

      const timeouts = await ref.call({ type: "getTimeouts" });
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("recurring timeouts", () => {
    it("should fire multiple timeouts if actor remains idle", async () => {
      const ref = system.spawn(TimeoutTrackingActor);
      ref.cast({ type: "setIdleTimeout", timeoutMs: 30 });

      // Wait for multiple timeouts
      await new Promise((resolve) => setTimeout(resolve, 150));

      const count = await ref.call({ type: "getTimeoutCount" });
      // Should have fired multiple times (at least 3-4 times in 150ms with 30ms timeout)
      expect(count).toBeGreaterThanOrEqual(3);
    });
  });

  describe("cleanup", () => {
    it("should clear timeout when actor is stopped", async () => {
      const ref = system.spawn(TimeoutTrackingActor);
      ref.cast({ type: "setIdleTimeout", timeoutMs: 50 });

      // Stop the actor before timeout fires
      await new Promise((resolve) => setTimeout(resolve, 20));
      await system.stop(ref);

      // Wait past when timeout would have fired
      await new Promise((resolve) => setTimeout(resolve, 100));

      // No error should occur (timeout was cleared)
      // If it wasn't cleared, we'd get an error trying to access the stopped actor
    });

    it("should allow actor to stop itself on timeout", async () => {
      const ref = system.spawn(SelfStoppingActor);

      // Poll instead of fixed wait - more reliable under CPU load
      await waitFor(() => !system.getLocalActorIds().includes(ref.id.id));

      expect(system.getLocalActorIds()).not.toContain(ref.id.id);
    });
  });

  describe("idleMs accuracy", () => {
    it("should report accurate idle duration", async () => {
      const ref = system.spawn(TimeoutTrackingActor);
      ref.cast({ type: "setIdleTimeout", timeoutMs: 50 });

      // Wait for cast to be processed before timing starts
      await new Promise((resolve) => setTimeout(resolve, 10));

      await new Promise((resolve) => setTimeout(resolve, 100));

      const timeouts = await ref.call({ type: "getTimeouts" });
      expect(timeouts.length).toBeGreaterThanOrEqual(1);

      // idleMs should be approximately the timeout value (with some tolerance for timing)
      // Under CPU pressure (e.g., parallel tests), timers can fire late
      const idleMs = timeouts[0].idleMs;
      expect(idleMs).toBeGreaterThanOrEqual(45); // Allow some tolerance
      expect(idleMs).toBeLessThan(300); // Allow for CI timing variance
    });
  });
});
