import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Actor,
  ActorId,
  ActorRef,
  ActorSystem,
  Cluster,
  Consumer,
  InMemoryTransport,
  LocalRegistry,
  Producer,
  telemetry,
  TelemetryEvents,
} from "../src";
import type {
  EventName,
  Measurements,
  Metadata,
  TelemetryHandler,
} from "../src";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}

  getMembers(): string[] {
    return [this.nodeId];
  }
}

class TestActor extends Actor {
  private casts = 0;

  init(): void {
    // noop
  }

  handleCall(msg: any): any {
    if (msg === "get-casts") return this.casts;
    return msg;
  }

  handleCast(msg: any): void {
    if (msg === "inc") this.casts += 1;
  }
}

class ParentActor extends Actor {
  init(): void {
    this.spawn(TestActor, { name: "child" });
  }

  handleCall(msg: any): any {
    return msg;
  }

  handleCast(_msg: any): void {
    // noop
  }
}

class ThrowingActor extends Actor {
  handleCall(msg: any): any {
    if (msg === "throw") throw new Error("call boom");
    return msg;
  }

  handleCast(msg: any): void {
    if (msg === "throw") throw new Error("cast boom");
  }
}

class CrashingActor extends Actor {
  handleCall(msg: any): any {
    return msg;
  }

  handleCast(msg: any): void {
    if (msg === "crash") throw new Error("test crash");
  }
}

class IntegrationActor extends Actor {
  handleCall(msg: any): any {
    return msg;
  }

  handleCast(msg: any): void {
    if (msg === "crash") throw new Error("integration crash");
  }
}

function createCollector() {
  const events: Array<{
    name: EventName;
    measurements: Measurements;
    metadata: Metadata;
  }> = [];

  const handler: TelemetryHandler = (name, measurements, metadata) => {
    events.push({ name, measurements, metadata });
  };

  return { events, handler };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventKey(name: EventName): string {
  return name.join(".");
}

describe("telemetry", () => {
  describe("core telemetry API", () => {
    beforeEach(() => {
      telemetry.reset();
    });

    afterEach(() => {
      telemetry.reset();
    });

    it("attach() registers handler and returns id", () => {
      const handler = vi.fn<TelemetryHandler>();
      const id = telemetry.attach("h1", [["a", "b"]], handler);

      expect(id).toBe("h1");
      expect(telemetry.listHandlers()).toContain("h1");
    });

    it("attach() with duplicate id throws error", () => {
      const handler = vi.fn<TelemetryHandler>();
      telemetry.attach("dup", [["a"]], handler);

      expect(() => telemetry.attach("dup", [["b"]], handler)).toThrow(
        /already attached/i,
      );
    });

    it("detach() removes handler and returns true", () => {
      telemetry.attach("h1", [["a"]], () => {});

      expect(telemetry.detach("h1")).toBe(true);
      expect(telemetry.listHandlers()).not.toContain("h1");
    });

    it("detach() with unknown id returns false", () => {
      expect(telemetry.detach("missing")).toBe(false);
    });

    it("execute() calls matching handlers synchronously", () => {
      const calls: number[] = [];
      telemetry.attach("h1", [["sync"]], () => {
        calls.push(1);
      });

      telemetry.execute(["sync"], {}, {});

      expect(calls).toEqual([1]);
    });

    it("execute() is a no-op when no handlers attached", () => {
      expect(() => telemetry.execute(["none"], {}, {})).not.toThrow();
    });

    it("execute() catches handler errors silently", () => {
      telemetry.attach("bad", [["boom"]], () => {
        throw new Error("bad handler");
      });

      expect(() => telemetry.execute(["boom"], {}, {})).not.toThrow();
    });

    it("execute() calls multiple handlers on same event", () => {
      const order: string[] = [];
      telemetry.attach("h1", [["same"]], () => order.push("h1"));
      telemetry.attach("h2", [["same"]], () => order.push("h2"));

      telemetry.execute(["same"], {}, {});

      expect(order).toEqual(["h1", "h2"]);
    });

    it("hasHandlers() returns true when handlers attached, false when not", () => {
      expect(telemetry.hasHandlers(["event"])).toBe(false);

      telemetry.attach("h1", [["event"]], () => {});

      expect(telemetry.hasHandlers(["event"])).toBe(true);
    });

    it("hasHandlers() returns false after detach", () => {
      telemetry.attach("h1", [["event"]], () => {});
      telemetry.detach("h1");

      expect(telemetry.hasHandlers(["event"])).toBe(false);
    });

    it("listHandlers() returns attached handler ids", () => {
      telemetry.attach("a", [["x"]], () => {});
      telemetry.attach("b", [["y"]], () => {});

      expect(new Set(telemetry.listHandlers())).toEqual(new Set(["a", "b"]));
    });

    it("reset() clears all handlers", () => {
      telemetry.attach("a", [["x"]], () => {});
      telemetry.attach("b", [["y"]], () => {});

      telemetry.reset();

      expect(telemetry.listHandlers()).toEqual([]);
      expect(telemetry.hasHandlers(["x"])).toBe(false);
      expect(telemetry.hasHandlers(["y"])).toBe(false);
    });
  });

  describe("span API", () => {
    beforeEach(() => {
      telemetry.reset();
    });

    afterEach(() => {
      telemetry.reset();
    });

    it("span() emits start and stop events with duration_ms", () => {
      const collector = createCollector();
      telemetry.attach(
        "span",
        [
          [...TelemetryEvents.actor.handleCall, "start"],
          [...TelemetryEvents.actor.handleCall, "stop"],
        ],
        collector.handler,
      );

      const result = telemetry.span(TelemetryEvents.actor.handleCall, { tag: "sync" }, () => {
        return 42;
      });

      expect(result).toBe(42);
      expect(collector.events).toHaveLength(2);
      expect(collector.events[0].name).toEqual([
        ...TelemetryEvents.actor.handleCall,
        "start",
      ]);
      expect(collector.events[1].name).toEqual([
        ...TelemetryEvents.actor.handleCall,
        "stop",
      ]);
      expect(collector.events[1].measurements.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("span() emits start and exception events when function throws and re-throws", () => {
      const collector = createCollector();
      telemetry.attach(
        "span-ex",
        [
          [...TelemetryEvents.actor.handleCall, "start"],
          [...TelemetryEvents.actor.handleCall, "exception"],
        ],
        collector.handler,
      );

      expect(() =>
        telemetry.span(TelemetryEvents.actor.handleCall, { tag: "throw" }, () => {
          throw new Error("span exploded");
        }),
      ).toThrow("span exploded");

      expect(collector.events).toHaveLength(2);
      expect(collector.events[0].name).toEqual([
        ...TelemetryEvents.actor.handleCall,
        "start",
      ]);
      expect(collector.events[1].name).toEqual([
        ...TelemetryEvents.actor.handleCall,
        "exception",
      ]);
      expect(collector.events[1].metadata.error).toBeInstanceOf(Error);
    });

    it("span() works with async functions", async () => {
      const collector = createCollector();
      telemetry.attach(
        "span-async",
        [
          [...TelemetryEvents.actor.handleCall, "start"],
          [...TelemetryEvents.actor.handleCall, "stop"],
        ],
        collector.handler,
      );

      const result = await telemetry.span(
        TelemetryEvents.actor.handleCall,
        { tag: "async" },
        async () => {
          await wait(20);
          return "ok";
        },
      );

      expect(result).toBe("ok");
      expect(collector.events).toHaveLength(2);
      expect(collector.events[1].name).toEqual([
        ...TelemetryEvents.actor.handleCall,
        "stop",
      ]);
    });

    it("span() measures duration_ms correctly (> 0 for async work)", async () => {
      const collector = createCollector();
      telemetry.attach(
        "span-duration",
        [[...TelemetryEvents.actor.handleCall, "stop"]],
        collector.handler,
      );

      await telemetry.span(TelemetryEvents.actor.handleCall, { tag: "d" }, async () => {
        await wait(25);
      });

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0].measurements.duration_ms).toBeGreaterThan(0);
    });
  });

  describe("actor lifecycle events", () => {
    let system: ActorSystem;

    beforeEach(async () => {
      telemetry.reset();
      const cluster = new MockCluster("test-node");
      const transport = new InMemoryTransport(cluster.nodeId);
      const registry = new LocalRegistry();
      system = new ActorSystem(cluster, transport, registry);
      await system.start();
    });

    afterEach(async () => {
      telemetry.reset();
      await system.shutdown();
    });

    it("spawning actor emits actor.spawn with actor_id, actor_class, node_id", async () => {
      const collector = createCollector();
      telemetry.attach("spawn", [TelemetryEvents.actor.spawn], collector.handler);

      const ref = system.spawn(TestActor, { name: "spawned" });
      await wait(50);

      const spawnEvent = collector.events.find((e) => e.metadata.actor_id === ref.id.id);
      expect(spawnEvent?.name).toEqual(TelemetryEvents.actor.spawn);
      expect(spawnEvent?.metadata.actor_class).toBe("TestActor");
      expect(spawnEvent?.metadata.node_id).toBe("test-node");
    });

    it("spawning child actor emits spawn event with parent_id", async () => {
      const collector = createCollector();
      telemetry.attach("spawn-child", [TelemetryEvents.actor.spawn], collector.handler);

      const parent = system.spawn(ParentActor);
      await wait(50);

      const childSpawn = collector.events.find(
        (e) => e.metadata.parent_id === parent.id.id,
      );

      expect(childSpawn).toBeDefined();
      expect(childSpawn?.metadata.actor_class).toBe("TestActor");
    });

    it("stopping actor emits actor.stop.stop with duration_ms, actor_id, children_stopped", async () => {
      const collector = createCollector();
      telemetry.attach(
        "stop",
        [[...TelemetryEvents.actor.stop, "stop"]],
        collector.handler,
      );

      const ref = system.spawn(TestActor);
      await wait(20);
      await system.stop(ref);

      const stopEvent = collector.events.find((e) => e.metadata.actor_id === ref.id.id);
      expect(stopEvent?.name).toEqual([...TelemetryEvents.actor.stop, "stop"]);
      expect(stopEvent?.measurements.duration_ms).toBeGreaterThanOrEqual(0);
      expect(stopEvent?.metadata.children_stopped).toBe(0);
    });

    it("actor init emits actor.init.stop with duration_ms", async () => {
      const collector = createCollector();
      telemetry.attach(
        "init",
        [[...TelemetryEvents.actor.init, "stop"]],
        collector.handler,
      );

      system.spawn(TestActor);
      await wait(50);

      expect(collector.events.length).toBeGreaterThan(0);
      expect(collector.events[0].name).toEqual([...TelemetryEvents.actor.init, "stop"]);
      expect(collector.events[0].measurements.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("system shutdown emits system.shutdown.stop with duration_ms, actor_count, node_id", async () => {
      const collector = createCollector();
      telemetry.attach(
        "shutdown",
        [[...TelemetryEvents.system.shutdown, "stop"]],
        collector.handler,
      );

      system.spawn(TestActor);
      await wait(20);
      await system.shutdown();

      expect(collector.events).toHaveLength(1);
      const shutdownEvent = collector.events[0];
      expect(shutdownEvent.name).toEqual([...TelemetryEvents.system.shutdown, "stop"]);
      expect(shutdownEvent.measurements.duration_ms).toBeGreaterThanOrEqual(0);
      expect(shutdownEvent.measurements.actor_count).toBeGreaterThanOrEqual(1);
      expect(shutdownEvent.metadata.node_id).toBe("test-node");
    });
  });

  describe("message processing events", () => {
    let system: ActorSystem;

    beforeEach(async () => {
      telemetry.reset();
      const cluster = new MockCluster("test-node");
      const transport = new InMemoryTransport(cluster.nodeId);
      const registry = new LocalRegistry();
      system = new ActorSystem(cluster, transport, registry);
      await system.start();
    });

    afterEach(async () => {
      telemetry.reset();
      await system.shutdown();
    });

    it("ref.call() emits handleCall start and stop with duration_ms", async () => {
      const collector = createCollector();
      telemetry.attach(
        "test-call",
        [
          [...TelemetryEvents.actor.handleCall, "start"],
          [...TelemetryEvents.actor.handleCall, "stop"],
          [...TelemetryEvents.actor.handleCall, "exception"],
        ],
        collector.handler,
      );

      const ref = system.spawn(TestActor);
      const value = await ref.call("hello");

      expect(value).toBe("hello");
      expect(collector.events.map((e) => e.name)).toContainEqual([
        ...TelemetryEvents.actor.handleCall,
        "start",
      ]);
      expect(collector.events.map((e) => e.name)).toContainEqual([
        ...TelemetryEvents.actor.handleCall,
        "stop",
      ]);

      const stopEvent = collector.events.find(
        (e) => eventKey(e.name) === eventKey([...TelemetryEvents.actor.handleCall, "stop"]),
      );
      expect(stopEvent?.measurements.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("ref.cast() emits handleCast start and stop", async () => {
      const collector = createCollector();
      telemetry.attach(
        "test-cast",
        [
          [...TelemetryEvents.actor.handleCast, "start"],
          [...TelemetryEvents.actor.handleCast, "stop"],
          [...TelemetryEvents.actor.handleCast, "exception"],
        ],
        collector.handler,
      );

      const ref = system.spawn(TestActor);
      ref.cast("inc");
      await wait(50);

      expect(collector.events.map((e) => e.name)).toContainEqual([
        ...TelemetryEvents.actor.handleCast,
        "start",
      ]);
      expect(collector.events.map((e) => e.name)).toContainEqual([
        ...TelemetryEvents.actor.handleCast,
        "stop",
      ]);
    });

    it("call exception emits handleCall.exception", async () => {
      const collector = createCollector();
      telemetry.attach(
        "test-call-ex",
        [
          [...TelemetryEvents.actor.handleCall, "start"],
          [...TelemetryEvents.actor.handleCall, "stop"],
          [...TelemetryEvents.actor.handleCall, "exception"],
        ],
        collector.handler,
      );

      const ref = system.spawn(ThrowingActor);
      await expect(ref.call("throw")).rejects.toThrow("call boom");

      expect(collector.events.map((e) => e.name)).toContainEqual([
        ...TelemetryEvents.actor.handleCall,
        "exception",
      ]);
    });

    it("cast exception emits handleCast.exception", async () => {
      const collector = createCollector();
      telemetry.attach(
        "test-cast-ex",
        [
          [...TelemetryEvents.actor.handleCast, "start"],
          [...TelemetryEvents.actor.handleCast, "stop"],
          [...TelemetryEvents.actor.handleCast, "exception"],
        ],
        collector.handler,
      );

      const ref = system.spawn(ThrowingActor);
      ref.cast("throw");
      await wait(50);

      expect(collector.events.map((e) => e.name)).toContainEqual([
        ...TelemetryEvents.actor.handleCast,
        "exception",
      ]);
    });

    it("with no handlers attached, call/cast work normally", async () => {
      const ref = system.spawn(TestActor);

      await expect(ref.call("ok")).resolves.toBe("ok");
      ref.cast("inc");
      await wait(50);

      expect(await ref.call("get-casts")).toBe(1);
      expect(telemetry.listHandlers()).toEqual([]);
    });
  });

  describe("supervision events", () => {
    let system: ActorSystem;

    beforeEach(async () => {
      telemetry.reset();
      const cluster = new MockCluster("test-node");
      const transport = new InMemoryTransport(cluster.nodeId);
      const registry = new LocalRegistry();
      system = new ActorSystem(cluster, transport, registry);
      await system.start();
    });

    afterEach(async () => {
      telemetry.reset();
      await system.shutdown();
    });

    it("actor crash emits supervisor.crash with actor_id, error, strategy", async () => {
      const collector = createCollector();
      telemetry.attach(
        "test-sup",
        [TelemetryEvents.supervisor.crash, TelemetryEvents.supervisor.restart],
        collector.handler,
      );

      const ref = system.spawn(CrashingActor);
      ref.cast("crash");
      await wait(200);

      const crash = collector.events.find(
        (e) => eventKey(e.name) === eventKey(TelemetryEvents.supervisor.crash),
      );
      expect(crash).toBeDefined();
      expect(crash?.metadata.actor_id).toBe(ref.id.id);
      expect(crash?.metadata.error).toBe("test crash");
      expect(crash?.metadata.strategy).toBe("Restart");
    });

    it("actor restart emits supervisor.restart with actor_id and new_actor_id", async () => {
      const collector = createCollector();
      telemetry.attach(
        "test-sup",
        [TelemetryEvents.supervisor.crash, TelemetryEvents.supervisor.restart],
        collector.handler,
      );

      const ref = system.spawn(CrashingActor);
      ref.cast("crash");
      await wait(200);

      const restart = collector.events.find(
        (e) => eventKey(e.name) === eventKey(TelemetryEvents.supervisor.restart),
      );

      expect(restart).toBeDefined();
      expect(restart?.metadata.actor_id).toBe(ref.id.id);
      expect(restart?.metadata.new_actor_id).toBeTruthy();
      expect(restart?.metadata.new_actor_id).not.toBe(ref.id.id);
    });
  });

  describe("gen stage telemetry events", () => {
    let system: ActorSystem;

    beforeEach(async () => {
      telemetry.reset();
      const cluster = new MockCluster("test-node");
      const transport = new InMemoryTransport(cluster.nodeId);
      const registry = new LocalRegistry();
      system = new ActorSystem(cluster, transport, registry);
      await system.start();
    });

    afterEach(async () => {
      telemetry.reset();
      await system.shutdown();
    });

    it("emits subscribe, dispatch, bufferOverflow, and cancel events", async () => {
      const collector = createCollector();
      telemetry.attach(
        "gen-stage",
        [
          TelemetryEvents.genStage.subscribe,
          TelemetryEvents.genStage.dispatch,
          TelemetryEvents.genStage.bufferOverflow,
          TelemetryEvents.genStage.cancel,
        ],
        collector.handler,
      );

      const producer = Producer.start(
        system,
        {
          init: () => 0,
          handleDemand: (demand, counter) => {
            const events = Array.from({ length: Math.max(demand, 1) * 10 }, (_, i) => counter + i);
            return [events, counter + events.length];
          },
        },
        { bufferSize: 1, bufferKeep: "last" },
      );

      const consumer = Consumer.start(system, {
        handleEvents: (_events, _from, state: number) => state,
        init: () => 0,
      });

      const sub = await consumer.subscribe(producer.getRef(), { maxDemand: 1, minDemand: 0 });
      await wait(150);
      consumer.cancel(sub);
      await wait(50);

      await consumer.stop();
      await producer.stop();

      expect(collector.events.map((e) => e.name)).toContainEqual(TelemetryEvents.genStage.subscribe);
      expect(collector.events.map((e) => e.name)).toContainEqual(TelemetryEvents.genStage.dispatch);
      expect(collector.events.map((e) => e.name)).toContainEqual(TelemetryEvents.genStage.bufferOverflow);
      expect(collector.events.map((e) => e.name)).toContainEqual(TelemetryEvents.genStage.cancel);
    });
  });

  describe("handler error isolation", () => {
    let system: ActorSystem;

    beforeEach(async () => {
      telemetry.reset();
      const cluster = new MockCluster("test-node");
      const transport = new InMemoryTransport(cluster.nodeId);
      const registry = new LocalRegistry();
      system = new ActorSystem(cluster, transport, registry);
      await system.start();
    });

    afterEach(async () => {
      telemetry.reset();
      await system.shutdown();
    });

    it("handler error does not affect other handlers", () => {
      const good: Metadata[] = [];
      telemetry.attach("bad", [["test"]], () => {
        throw new Error("bad handler");
      });
      telemetry.attach("good", [["test"]], (_name, _m, meta) => {
        good.push(meta);
      });

      telemetry.execute(["test"], {}, { value: 1 });

      expect(good).toHaveLength(1);
      expect(good[0].value).toBe(1);
    });

    it("handler error does not affect actor system behavior", async () => {
      telemetry.attach("bad-call", [[...TelemetryEvents.actor.handleCall, "stop"]], () => {
        throw new Error("handler failed");
      });

      const ref = system.spawn(TestActor);
      await expect(ref.call("safe")).resolves.toBe("safe");

      ref.cast("inc");
      await wait(50);
      await expect(ref.call("get-casts")).resolves.toBe(1);
    });
  });

  describe("integration", () => {
    let system: ActorSystem;

    beforeEach(async () => {
      telemetry.reset();
      const cluster = new MockCluster("test-node");
      const transport = new InMemoryTransport(cluster.nodeId);
      const registry = new LocalRegistry();
      system = new ActorSystem(cluster, transport, registry);
      await system.start();
    });

    afterEach(async () => {
      telemetry.reset();
      await system.shutdown();
    });

    it("collects full pipeline events in order", async () => {
      const collector = createCollector();
      telemetry.attach(
        "integration",
        [
          TelemetryEvents.actor.spawn,
          [...TelemetryEvents.actor.init, "stop"],
          [...TelemetryEvents.actor.handleCall, "start"],
          [...TelemetryEvents.actor.handleCall, "stop"],
          [...TelemetryEvents.actor.handleCast, "start"],
          [...TelemetryEvents.actor.handleCast, "stop"],
          [...TelemetryEvents.actor.handleCast, "exception"],
          TelemetryEvents.supervisor.crash,
          TelemetryEvents.supervisor.restart,
          [...TelemetryEvents.actor.stop, "stop"],
        ],
        collector.handler,
      );

      const ref = system.spawn(IntegrationActor);
      await wait(50);
      await ref.call("ping");
      ref.cast("ok");
      await wait(50);
      ref.cast("crash");
      await wait(200);

      const restartEvent = collector.events.find(
        (e) => eventKey(e.name) === eventKey(TelemetryEvents.supervisor.restart),
      );
      expect(restartEvent).toBeDefined();

      const restartedId = String(restartEvent?.metadata.new_actor_id);
      const restartedRef = new ActorRef(new ActorId(system.id, restartedId), system);
      await system.stop(restartedRef);

      const names = collector.events.map((e) => eventKey(e.name));

      const required = [
        eventKey(TelemetryEvents.actor.spawn),
        eventKey([...TelemetryEvents.actor.handleCall, "start"]),
        eventKey([...TelemetryEvents.actor.handleCall, "stop"]),
        eventKey([...TelemetryEvents.actor.handleCast, "start"]),
        eventKey([...TelemetryEvents.actor.handleCast, "exception"]),
        eventKey(TelemetryEvents.supervisor.crash),
        eventKey(TelemetryEvents.supervisor.restart),
        eventKey([...TelemetryEvents.actor.stop, "stop"]),
      ];

      for (const key of required) {
        expect(names).toContain(key);
      }

      const indexSpawn = names.indexOf(eventKey(TelemetryEvents.actor.spawn));
      const indexCallStart = names.indexOf(eventKey([...TelemetryEvents.actor.handleCall, "start"]));
      const indexCallStop = names.indexOf(eventKey([...TelemetryEvents.actor.handleCall, "stop"]));
      const indexCrash = names.indexOf(eventKey(TelemetryEvents.supervisor.crash));
      const indexRestart = names.indexOf(eventKey(TelemetryEvents.supervisor.restart));
      const indexStop = names.lastIndexOf(eventKey([...TelemetryEvents.actor.stop, "stop"]));

      expect(indexSpawn).toBeLessThan(indexCallStart);
      expect(indexCallStart).toBeLessThan(indexCallStop);
      expect(indexCallStop).toBeLessThan(indexCrash);
      expect(indexCrash).toBeLessThan(indexRestart);
      expect(indexRestart).toBeLessThan(indexStop);
    });
  });
});
