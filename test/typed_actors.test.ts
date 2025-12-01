import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorRef,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  InMemoryRegistry,
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

// ============================================================================
// Counter Actor - Simple typed actor example
// ============================================================================

type CounterCast =
  | { type: "increment" }
  | { type: "decrement" }
  | { type: "add"; amount: number };

type CounterCall = { type: "get" } | { type: "getAndReset" };

type CounterReply = number;

class CounterActor extends Actor<CounterCast, CounterCall, CounterReply> {
  private count = 0;

  init(initialValue: number = 0) {
    this.count = initialValue;
  }

  handleCast(message: CounterCast): void {
    switch (message.type) {
      case "increment":
        this.count++;
        break;
      case "decrement":
        this.count--;
        break;
      case "add":
        this.count += message.amount;
        break;
    }
  }

  handleCall(message: CounterCall): CounterReply {
    switch (message.type) {
      case "get":
        return this.count;
      case "getAndReset":
        const value = this.count;
        this.count = 0;
        return value;
    }
  }
}

// ============================================================================
// Echo Actor - Tests async handlers
// ============================================================================

type EchoCast = { type: "log"; message: string };
type EchoCall =
  | { type: "echo"; message: string }
  | { type: "delay"; ms: number };
type EchoReply = string;

class EchoActor extends Actor<EchoCast, EchoCall, EchoReply> {
  public logs: string[] = [];

  handleCast(message: EchoCast): void {
    if (message.type === "log") {
      this.logs.push(message.message);
    }
  }

  async handleCall(message: EchoCall): Promise<EchoReply> {
    switch (message.type) {
      case "echo":
        return `echo: ${message.message}`;
      case "delay":
        await new Promise((resolve) => setTimeout(resolve, message.ms));
        return `delayed ${message.ms}ms`;
    }
  }
}

// ============================================================================
// Parent-Child Typed Actors
// ============================================================================

type WorkerCast = { type: "doWork"; task: string };
type WorkerCall = { type: "getCompleted" };
type WorkerReply = string[];

class WorkerActor extends Actor<WorkerCast, WorkerCall, WorkerReply> {
  private completed: string[] = [];

  handleCast(message: WorkerCast): void {
    if (message.type === "doWork") {
      this.completed.push(message.task);
    }
  }

  handleCall(message: WorkerCall): WorkerReply {
    if (message.type === "getCompleted") {
      return this.completed;
    }
    return [];
  }
}

type ManagerCast = { type: "assignTask"; task: string };
type ManagerCall = { type: "getWorkerResults" };
type ManagerReply = string[];

class ManagerActor extends Actor<ManagerCast, ManagerCall, ManagerReply> {
  private workerRef!: ActorRef<WorkerCast, WorkerCall, WorkerReply>;

  init() {
    this.workerRef = this.spawn(WorkerActor);
  }

  handleCast(message: ManagerCast): void {
    if (message.type === "assignTask") {
      this.workerRef.cast({ type: "doWork", task: message.task });
    }
  }

  async handleCall(message: ManagerCall): Promise<ManagerReply> {
    if (message.type === "getWorkerResults") {
      return await this.workerRef.call({ type: "getCompleted" });
    }
    return [];
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Typed Actors", () => {
  let system: ActorSystem;
  let transport: InMemoryTransport;
  let registry: InMemoryRegistry;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    transport = new InMemoryTransport("test-node");
    registry = new InMemoryRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("ActorRef with type parameters", () => {
    it("should provide type-safe cast messages", async () => {
      const counter = system.spawn(CounterActor);

      // These are type-checked at compile time
      counter.cast({ type: "increment" });
      counter.cast({ type: "increment" });
      counter.cast({ type: "add", amount: 5 });
      counter.cast({ type: "decrement" });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const value = await counter.call({ type: "get" });
      expect(value).toBe(6); // 0 + 1 + 1 + 5 - 1 = 6
    });

    it("should provide type-safe call messages with typed returns", async () => {
      const counter = system.spawn(CounterActor, { args: [10] });

      // Return type is inferred as number
      const value = await counter.call({ type: "get" });
      expect(value).toBe(10);

      const reset = await counter.call({ type: "getAndReset" });
      expect(reset).toBe(10);

      const afterReset = await counter.call({ type: "get" });
      expect(afterReset).toBe(0);
    });

    it("should work with untyped ActorRef for compatibility", async () => {
      // Can assign to untyped ActorRef
      const counter: ActorRef = system.spawn(CounterActor);

      // Untyped ref can send any message (no compile-time checking)
      counter.cast({ type: "increment" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const value = await counter.call({ type: "get" });
      expect(value).toBe(1);
    });
  });

  describe("Typed Actor", () => {
    it("should handle async call handlers", async () => {
      const echo = system.spawn(EchoActor);

      const result = await echo.call({ type: "echo", message: "hello" });
      expect(result).toBe("echo: hello");

      const delayed = await echo.call({ type: "delay", ms: 10 });
      expect(delayed).toBe("delayed 10ms");
    });

    it("should handle cast messages", async () => {
      const echo = system.spawn(EchoActor);

      echo.cast({ type: "log", message: "msg1" });
      echo.cast({ type: "log", message: "msg2" });

      await new Promise((resolve) => setTimeout(resolve, 30));

      // Access internal state through getActor
      const actor = system.getActor(echo.id.id) as unknown as EchoActor;
      expect(actor.logs).toEqual(["msg1", "msg2"]);
    });

    it("should provide typed self reference", async () => {
      const counter = system.spawn(CounterActor);

      // Verify the actor was spawned correctly
      const actor = system.getActor(counter.id.id) as unknown as CounterActor;
      expect(actor).toBeDefined();

      // self should have same ID and be typed
      expect(actor.self.id.id).toBe(counter.id.id);
    });
  });

  describe("Typed child actors", () => {
    it("should spawn typed children with spawn", async () => {
      const manager = system.spawn(ManagerActor);

      // Assign tasks through the manager
      manager.cast({ type: "assignTask", task: "task1" });
      manager.cast({ type: "assignTask", task: "task2" });
      manager.cast({ type: "assignTask", task: "task3" });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get results from worker through manager
      const results = await manager.call({ type: "getWorkerResults" });
      expect(results).toEqual(["task1", "task2", "task3"]);
    });
  });

  describe("Type safety demonstration", () => {
    it("should work with discriminated unions", async () => {
      const counter = system.spawn(CounterActor, { args: [100] });

      // All these message types are checked at compile time
      counter.cast({ type: "increment" });
      counter.cast({ type: "decrement" });
      counter.cast({ type: "add", amount: 50 });

      await new Promise((resolve) => setTimeout(resolve, 30));

      const finalValue = await counter.call({ type: "get" });
      expect(finalValue).toBe(150); // 100 + 1 - 1 + 50 = 150
    });

    it("should handle multiple typed actors of different types", async () => {
      const counter = system.spawn(CounterActor, { args: [0] });
      const echo = system.spawn(EchoActor);

      // Each ref only accepts its own message types
      counter.cast({ type: "increment" });
      echo.cast({ type: "log", message: "hello" });

      await new Promise((resolve) => setTimeout(resolve, 30));

      const count = await counter.call({ type: "get" });
      const echoResult = await echo.call({ type: "echo", message: "world" });

      expect(count).toBe(1);
      expect(echoResult).toBe("echo: world");
    });
  });
});
