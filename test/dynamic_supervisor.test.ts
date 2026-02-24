import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor, ActorRef, ActorSystem, Cluster, InMemoryTransport, LocalRegistry,
  DynamicSupervisor, MaxChildrenError, createActor,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

const initEvents: string[] = [];
const terminateEvents: string[] = [];

class WorkerActor extends Actor {
  private name = "";

  init(name: string) {
    this.name = name;
    initEvents.push(`init:${name}`);
  }

  terminate() {
    terminateEvents.push(`terminate:${this.name}`);
  }

  handleCall(message: { type: "get_name" } | { type: "ping" }): string {
    if (message.type === "get_name") {
      return this.name;
    }
    return "pong";
  }

  handleCast(message: { type: "crash" }): void {
    if (message.type === "crash") {
      throw new Error(`${this.name} crashed`);
    }
  }
}

const Counter = createActor((_, self, initial: number) => {
  let count = initial;
  return self
    .onCall("get", () => count)
    .onCall("increment", () => ++count)
    .onCast("set", (v: number) => { count = v; });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("DynamicSupervisor", () => {
  let system: ActorSystem;

  beforeEach(async () => {
    initEvents.length = 0;
    terminateEvents.length = 0;

    const cluster = new MockCluster("test-node");
    const transport = new InMemoryTransport(cluster.nodeId);
    const registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("basic lifecycle", () => {
    it("starts and stops", async () => {
      const dynSup = DynamicSupervisor.start(system);
      const counts = await dynSup.countChildren();

      expect(counts).toEqual({ specs: 0, active: 0 });

      await dynSup.stop();
    });

    it("supports options", async () => {
      const dynSup = DynamicSupervisor.start(system, { maxChildren: 1 });
      await dynSup.startChild(WorkerActor, { args: ["w1"] });

      await expect(
        dynSup.startChild(WorkerActor, { args: ["w2"] }),
      ).rejects.toBeInstanceOf(MaxChildrenError);

      await dynSup.stop();
    });

    it("supports named supervisors", async () => {
      const dynSup = DynamicSupervisor.start(system, {}, { name: "dyn-sup" });

      expect(dynSup.getRef().id.name).toBe("dyn-sup");

      await dynSup.stop();
    });
  });

  describe("startChild", () => {
    it("starts class-based child with args and optional name", async () => {
      const dynSup = DynamicSupervisor.start(system);
      const child = await dynSup.startChild(WorkerActor, {
        name: "worker-one",
        args: ["w1"],
      });

      expect(await child.call({ type: "get_name" })).toBe("w1");

      const children = await dynSup.whichChildren();
      expect(children).toHaveLength(1);
      expect(children[0].className).toBe("WorkerActor");
      expect(children[0].name).toBe("worker-one");

      await dynSup.stop();
    });

    it("starts functional child and returns typed ref behavior", async () => {
      const dynSup = DynamicSupervisor.start(system);
      const counter = await dynSup.startChild(Counter, { args: [5] });

      expect(await counter.call("get")).toBe(5);
      expect(await counter.call("increment")).toBe(6);
      counter.cast("set", 42);
      await sleep(50);
      expect(await counter.call("get")).toBe(42);

      await dynSup.stop();
    });

    it("enforces maxChildren and frees slot after terminate", async () => {
      const dynSup = DynamicSupervisor.start(system, { maxChildren: 2 });
      const child1 = await dynSup.startChild(WorkerActor, { args: ["w1"] });
      await dynSup.startChild(WorkerActor, { args: ["w2"] });

      await expect(
        dynSup.startChild(WorkerActor, { args: ["w3"] }),
      ).rejects.toBeInstanceOf(MaxChildrenError);

      expect(await dynSup.terminateChild(child1)).toBe(true);
      await sleep(100);

      const child3 = await dynSup.startChild(WorkerActor, { args: ["w3"] });
      expect(await child3.call({ type: "get_name" })).toBe("w3");

      const counts = await dynSup.countChildren();
      expect(counts.active).toBe(2);

      await dynSup.stop();
    });
  });

  describe("terminateChild", () => {
    it("stops a child and returns false for unknown ref", async () => {
      const dynSup = DynamicSupervisor.start(system, { maxChildren: 1 });
      const child = await dynSup.startChild(WorkerActor, { args: ["w1"] });

      expect(await dynSup.terminateChild(child)).toBe(true);
      await sleep(100);
      expect(await dynSup.terminateChild(child)).toBe(false);

      const replacement = await dynSup.startChild(WorkerActor, { args: ["w2"] });
      expect(await replacement.call({ type: "get_name" })).toBe("w2");

      await dynSup.stop();
    });

    it("returns false for ref not managed by supervisor", async () => {
      const dynSup1 = DynamicSupervisor.start(system);
      const dynSup2 = DynamicSupervisor.start(system);
      const childOfSup2 = await dynSup2.startChild(WorkerActor, { args: ["x"] });
      const foreignRef: ActorRef = childOfSup2;

      expect(await dynSup1.terminateChild(foreignRef)).toBe(false);
      expect(await childOfSup2.call({ type: "ping" })).toBe("pong");

      await dynSup1.stop();
      await dynSup2.stop();
    });
  });

  describe("whichChildren and countChildren", () => {
    it("is empty initially and reflects start/terminate transitions", async () => {
      const dynSup = DynamicSupervisor.start(system);

      expect(await dynSup.whichChildren()).toEqual([]);
      expect(await dynSup.countChildren()).toEqual({ specs: 0, active: 0 });

      const c1 = await dynSup.startChild(WorkerActor, { args: ["w1"] });
      await dynSup.startChild(WorkerActor, { args: ["w2"], name: "named-w2" });

      const childrenAfterStart = await dynSup.whichChildren();
      expect(childrenAfterStart).toHaveLength(2);
      expect(childrenAfterStart.map((c) => c.className)).toEqual([
        "WorkerActor",
        "WorkerActor",
      ]);
      expect(childrenAfterStart.some((c) => c.name === "named-w2")).toBe(true);
      expect(await dynSup.countChildren()).toEqual({ specs: 2, active: 2 });

      expect(await dynSup.terminateChild(c1)).toBe(true);
      await sleep(100);

      expect(await dynSup.countChildren()).toEqual({ specs: 1, active: 1 });
      expect((await dynSup.whichChildren()).length).toBe(1);

      await dynSup.stop();
    });
  });

  describe("supervision and restart behavior", () => {
    it("restarts crashed child and restarted child is functional", async () => {
      const dynSup = DynamicSupervisor.start(system, {
        maxRestarts: 1,
        periodMs: 5000,
      });
      const child = await dynSup.startChild(WorkerActor, { args: ["w1"] });

      child.cast({ type: "crash" });
      await sleep(100);

      const counts = await dynSup.countChildren();
      expect(counts.active).toBe(1);

      const children = await dynSup.whichChildren();
      expect(children).toHaveLength(1);
      const restarted = children[0].ref;
      expect(restarted.id.id).not.toBe(child.id.id);
      expect(await restarted.call({ type: "ping" })).toBe("pong");

      await dynSup.stop();
    });

    it("permanently stops child after exceeding maxRestarts", async () => {
      const dynSup = DynamicSupervisor.start(system, {
        maxRestarts: 1,
        periodMs: 5000,
      });
      const child = await dynSup.startChild(WorkerActor, { args: ["w1"] });

      child.cast({ type: "crash" });
      await sleep(100);

      const firstRestartedRef = (await dynSup.whichChildren())[0].ref;
      firstRestartedRef.cast({ type: "crash" });
      await sleep(200);

      const counts = await dynSup.countChildren();
      expect(counts).toEqual({ specs: 0, active: 0 });

      await dynSup.stop();
    });
  });

  describe("cascading termination", () => {
    it("stopping dynamic supervisor stops all children", async () => {
      const dynSup = DynamicSupervisor.start(system);
      await dynSup.startChild(WorkerActor, { args: ["w1"] });
      await dynSup.startChild(WorkerActor, { args: ["w2"] });
      await dynSup.startChild(WorkerActor, { args: ["w3"] });

      await dynSup.stop();
      await sleep(100);

      expect(terminateEvents).toContain("terminate:w1");
      expect(terminateEvents).toContain("terminate:w2");
      expect(terminateEvents).toContain("terminate:w3");
    });
  });
});
