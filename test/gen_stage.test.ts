import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Actor,
  ActorSystem,
  InMemoryTransport,
  LocalRegistry,
  Cluster,
} from "../src";
import {
  Producer,
  Consumer,
  ConsumerSupervisor,
  ProducerConsumer,
  ProducerOptions,
} from "../src/gen_stage";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await sleep(intervalMs);
  }
};

class TestWorker extends Actor {
  init(results: any[], event: any) {
    results.push(event);
    setTimeout(() => {
      void this.context.system.stop(this.self);
    }, 5);
  }

  handleCall(): undefined {
    return undefined;
  }

  handleCast(): void {}
}

class ArgsWorker extends Actor {
  init(results: Array<[string, any]>, marker: string, event: any) {
    results.push([marker, event]);
    setTimeout(() => {
      void this.context.system.stop(this.self);
    }, 5);
  }

  handleCall(): undefined {
    return undefined;
  }

  handleCast(): void {}
}

class DelayWorker extends Actor {
  init(
    counters: {
      current: { value: number };
      max: { value: number };
      done: any[];
      delayMs: number;
    },
    event: any,
  ) {
    counters.current.value += 1;
    if (counters.current.value > counters.max.value) {
      counters.max.value = counters.current.value;
    }
    setTimeout(() => {
      counters.current.value -= 1;
      counters.done.push(event);
      void this.context.system.stop(this.self);
    }, counters.delayMs);
  }

  handleCall(): undefined {
    return undefined;
  }

  handleCast(): void {}
}

class SlowWorker extends Actor {
  init(results: any[], event: any) {
    results.push(event);
  }

  handleCall(message: any): any {
    return message;
  }

  handleCast(message: { type: "stop" }): void {
    if (message.type === "stop") {
      void this.context.system.stop(this.self);
    }
  }
}

describe("GenStage", () => {
  let system: ActorSystem;

  beforeEach(async () => {
    const cluster = new MockCluster("test-node");
    const transport = new InMemoryTransport(cluster.nodeId);
    const registry = new LocalRegistry();
    system = new ActorSystem(cluster, transport, registry);
    await system.start();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  describe("Producer", () => {
    it("starts and stops", async () => {
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      expect(producer.getRef()).toBeDefined();
      await producer.stop();
    });

    it("buffers events when no subscribers", async () => {
      // Producer generates events on demand, but with no subscribers
      // demand never arrives — nothing should crash
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (_demand, state) => [[], state],
      });

      await sleep(20);
      await producer.stop();
    });
  });

  describe("Consumer", () => {
    it("starts and stops", async () => {
      const consumer = Consumer.start(system, {
        handleEvents: (_events, _from, state) => state,
      });

      expect(consumer.getRef()).toBeDefined();
      await consumer.stop();
    });
  });

  describe("Producer → Consumer pipeline", () => {
    it("delivers events via demand protocol", async () => {
      const received: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received.push(...events);
          return state;
        },
      });

      await consumer.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await sleep(50);

      // Consumer asked for maxDemand=10 initially, so producer should have emitted 10 events
      expect(received.length).toBeGreaterThanOrEqual(10);
      // Events should be sequential starting from 0
      expect(received.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      await consumer.stop();
      await producer.stop();
    });

    it("respects maxDemand — never receives more than requested", async () => {
      const batchSizes: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          batchSizes.push(events.length);
          return state;
        },
      });

      await consumer.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await sleep(50);

      // No single batch should exceed maxDemand
      for (const size of batchSizes) {
        expect(size).toBeLessThanOrEqual(5);
      }

      await consumer.stop();
      await producer.stop();
    });

    it("re-asks when demand drops to minDemand", async () => {
      const received: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received.push(...events);
          return state;
        },
      });

      // maxDemand=10, minDemand=5: after receiving 5+ events, consumer re-asks
      await consumer.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await sleep(100);

      // Should have received more than the initial maxDemand due to re-asking
      expect(received.length).toBeGreaterThan(10);

      await consumer.stop();
      await producer.stop();
    });
  });

  describe("multiple consumers", () => {
    it("distributes events across consumers", async () => {
      const received1: number[] = [];
      const received2: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      const consumer1 = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received1.push(...events);
          return state;
        },
      });

      const consumer2 = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received2.push(...events);
          return state;
        },
      });

      await consumer1.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await consumer2.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await sleep(50);

      // Both consumers should receive events
      expect(received1.length).toBeGreaterThan(0);
      expect(received2.length).toBeGreaterThan(0);

      // Combined should have no duplicates (DemandDispatcher splits events)
      const all = [...received1, ...received2].sort((a, b) => a - b);
      const unique = [...new Set(all)];
      expect(all).toEqual(unique);

      await consumer1.stop();
      await consumer2.stop();
      await producer.stop();
    });
  });

  describe("BroadcastDispatcher", () => {
    it("sends all events to all consumers (sequential subscribe)", async () => {
      const received1: number[] = [];
      const received2: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { dispatcher: { type: "broadcast" } });

      const consumer1 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received1.push(...events); return state; },
      });
      const consumer2 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received2.push(...events); return state; },
      });

      // Sequential subscribe — the Phase 1 fix ensures both consumers
      // register before any initial demand is processed.
      await consumer1.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await consumer2.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await sleep(100);

      expect(received1.length).toBeGreaterThan(0);
      expect(received2.length).toBeGreaterThan(0);
      expect(received1.slice(0, 10)).toEqual(received2.slice(0, 10));

      await consumer1.stop();
      await consumer2.stop();
      await producer.stop();
    });

    it("demand equals min of all consumers (slow consumer throttles)", async () => {
      const received1: number[] = [];
      const received2: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { dispatcher: { type: "broadcast" } });

      const consumer1 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received1.push(...events); return state; },
      });
      const consumer2 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received2.push(...events); return state; },
      });

      // Sequential subscribe — no Promise.all workaround needed
      await consumer1.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await consumer2.subscribe(producer.getRef(), { maxDemand: 3, minDemand: 1 });
      await sleep(100);

      expect(received1.slice(0, received2.length)).toEqual(received2.slice(0, received2.length));

      await consumer1.stop();
      await consumer2.stop();
      await producer.stop();
    });

    it("single consumer works like demand dispatcher", async () => {
      const received: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { dispatcher: { type: "broadcast" } });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received.push(...events); return state; },
      });

      await consumer.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await sleep(50);

      expect(received.length).toBeGreaterThanOrEqual(10);
      expect(received.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      await consumer.stop();
      await producer.stop();
    });
  });

    it("sequential subscribe with 3 consumers all receive same events", async () => {
      const received1: number[] = [];
      const received2: number[] = [];
      const received3: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { dispatcher: { type: "broadcast" } });

      const consumer1 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received1.push(...events); return state; },
      });
      const consumer2 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received2.push(...events); return state; },
      });
      const consumer3 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received3.push(...events); return state; },
      });

      // All sequential — no Promise.all
      await consumer1.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await consumer2.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await consumer3.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await sleep(100);

      expect(received1.length).toBeGreaterThan(0);
      expect(received2.length).toBeGreaterThan(0);
      expect(received3.length).toBeGreaterThan(0);
      // All three must receive the same initial events
      const len = Math.min(received1.length, received2.length, received3.length);
      expect(received1.slice(0, len)).toEqual(received2.slice(0, len));
      expect(received2.slice(0, len)).toEqual(received3.slice(0, len));

      await consumer1.stop();
      await consumer2.stop();
      await consumer3.stop();
      await producer.stop();
    });

    it("demand: accumulate pauses until demand('forward') is called", async () => {
      const received1: number[] = [];
      const received2: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { dispatcher: { type: "broadcast" }, demand: "accumulate" });

      const consumer1 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received1.push(...events); return state; },
      });
      const consumer2 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received2.push(...events); return state; },
      });

      await consumer1.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await consumer2.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });

      // No events should flow yet (demand is accumulated)
      await sleep(50);
      expect(received1.length).toBe(0);
      expect(received2.length).toBe(0);

      // Resume event production
      producer.demand("forward");
      await sleep(100);

      // Both should now have received events
      expect(received1.length).toBeGreaterThan(0);
      expect(received2.length).toBeGreaterThan(0);
      expect(received1.slice(0, 10)).toEqual(received2.slice(0, 10));

      await consumer1.stop();
      await consumer2.stop();
      await producer.stop();
    });

    it("demand: accumulate works with DemandDispatcher too", async () => {
      const received: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { demand: "accumulate" });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received.push(...events); return state; },
      });

      await consumer.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });

      // No events yet
      await sleep(50);
      expect(received.length).toBe(0);

      // Resume
      producer.demand("forward");
      await sleep(50);

      expect(received.length).toBeGreaterThanOrEqual(10);
      expect(received.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      await consumer.stop();
      await producer.stop();
    });

  describe("PartitionDispatcher", () => {
    it("routes events to correct partition by hash", async () => {
      const partition0: number[] = [];
      const partition1: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { dispatcher: { type: "partition", partitions: 2, hash: (e: number) => e % 2 } });

      const c0 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { partition0.push(...events); return state; },
      });
      const c1 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { partition1.push(...events); return state; },
      });

      await c0.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5, partition: 0 });
      await c1.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5, partition: 1 });
      await sleep(100);

      expect(partition0.length).toBeGreaterThan(0);
      expect(partition1.length).toBeGreaterThan(0);
      for (const e of partition0) expect(e % 2).toBe(0);
      for (const e of partition1) expect(e % 2).toBe(1);

      await c0.stop();
      await c1.stop();
      await producer.stop();
    });

    it("rejects duplicate partition subscription", async () => {
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (_demand, state) => [[], state],
      }, { dispatcher: { type: "partition", partitions: 2, hash: (e: number) => e % 2 } });

      const c0 = Consumer.start(system, {
        handleEvents: (_events, _from, state) => state,
      });
      const c1 = Consumer.start(system, {
        handleEvents: (_events, _from, state) => state,
      });

      await c0.subscribe(producer.getRef(), { maxDemand: 5, partition: 0 });
      await expect(c1.subscribe(producer.getRef(), { maxDemand: 5, partition: 0 })).rejects.toThrow();

      await c0.stop();
      await c1.stop();
      await producer.stop();
    });

    it("hash returning null discards event", async () => {
      const received: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, {
        dispatcher: {
          type: "partition",
          partitions: 1,
          hash: (e: number) => e % 2 === 0 ? 0 : null,
        },
      });

      const c0 = Consumer.start(system, {
        handleEvents: (events, _from, state) => { received.push(...events); return state; },
      });

      await c0.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5, partition: 0 });
      await sleep(100);

      expect(received.length).toBeGreaterThan(0);
      for (const e of received) expect(e % 2).toBe(0);

      await c0.stop();
      await producer.stop();
    });

    it("works in a 3-stage pipeline", async () => {
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      }, { dispatcher: { type: "partition", partitions: 2, hash: (e: number) => e % 2 } });

      const evenNums: number[] = [];
      const oddNums: number[] = [];

      const cEven = Consumer.start(system, {
        handleEvents: (events, _from, state) => { evenNums.push(...events); return state; },
      });
      const cOdd = Consumer.start(system, {
        handleEvents: (events, _from, state) => { oddNums.push(...events); return state; },
      });

      await cEven.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5, partition: 0 });
      await cOdd.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5, partition: 1 });
      await sleep(100);

      const all = [...evenNums, ...oddNums].sort((a, b) => a - b);
      const unique = [...new Set(all)];
      expect(all.length).toEqual(unique.length);
      expect(evenNums.length).toBeGreaterThan(0);
      expect(oddNums.length).toBeGreaterThan(0);

      await cEven.stop();
      await cOdd.stop();
      await producer.stop();
    });
  });

  describe("subscription cancel", () => {
    it("consumer cancels subscription", async () => {
      const received: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received.push(...events);
          return state;
        },
      });

      const sub = await consumer.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await sleep(30);

      const countBefore = received.length;
      expect(countBefore).toBeGreaterThan(0);

      consumer.cancel(sub);
      await sleep(30);

      const countAfter = received.length;

      // After cancel, no more events should arrive (or very few in-flight)
      await sleep(50);
      expect(received.length - countAfter).toBeLessThanOrEqual(1);

      await consumer.stop();
      await producer.stop();
    });
  });

  describe("ProducerConsumer", () => {
    it("transforms events in a 3-stage pipeline", async () => {
      const received: number[] = [];

      // Stage 1: produce sequential numbers
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      // Stage 2: multiply by 10
      const multiplier = ProducerConsumer.start(system, {
        init: () => 10,
        handleEvents: (events, _from, factor) => {
          return [events.map((e: number) => e * factor), factor];
        },
      });

      // Stage 3: collect results
      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received.push(...events);
          return state;
        },
      });

      // Wire: producer → multiplier → consumer
      await multiplier.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await consumer.subscribe(multiplier.getRef(), { maxDemand: 5, minDemand: 2 });
      await sleep(100);

      // Should have received multiplied values
      expect(received.length).toBeGreaterThan(0);
      // First 5 events should be 0*10, 1*10, 2*10, 3*10, 4*10
      expect(received.slice(0, 5)).toEqual([0, 10, 20, 30, 40]);

      await consumer.stop();
      await multiplier.stop();
      await producer.stop();
    });

    it("ProducerConsumer can filter events (N in, M out)", async () => {
      const received: number[] = [];

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      // Only pass through even numbers
      const filter = ProducerConsumer.start(system, {
        handleEvents: (events, _from, state) => {
          const evens = events.filter((e: number) => e % 2 === 0);
          return [evens, state];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received.push(...events);
          return state;
        },
      });

      await filter.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
      await consumer.subscribe(filter.getRef(), { maxDemand: 10, minDemand: 5 });
      await sleep(100);

      expect(received.length).toBeGreaterThan(0);
      // All received events should be even
      for (const event of received) {
        expect(event % 2).toBe(0);
      }

      await consumer.stop();
      await filter.stop();
      await producer.stop();
    });
  });

  describe("edge cases", () => {
    it("handles empty events from handleDemand", async () => {
      const received: number[] = [];
      let demandCount = 0;

      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (_demand, state) => {
          demandCount++;
          // Return no events — simulates "no data available yet"
          return [[], state];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received.push(...events);
          return state;
        },
      });

      await consumer.subscribe(producer.getRef(), { maxDemand: 5 });
      await sleep(50);

      // Producer was asked but returned nothing — no events should arrive
      expect(received.length).toBe(0);
      expect(demandCount).toBeGreaterThan(0);

      await consumer.stop();
      await producer.stop();
    });

    it("producer buffers events and drains on demand", async () => {
      const received: number[] = [];
      let firstDemand = true;

      // Producer emits extra events on first demand, they should be buffered
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          if (firstDemand) {
            firstDemand = false;
            // Emit more than requested — excess goes to buffer
            const extra = demand + 5;
            const events = Array.from({ length: extra }, (_, i) => counter + i);
            return [events, counter + extra];
          }
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (events, _from, state) => {
          received.push(...events);
          return state;
        },
      });

      await consumer.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await sleep(100);

      // Should eventually receive the extra buffered events too
      expect(received.length).toBeGreaterThan(5);

      await consumer.stop();
      await producer.stop();
    });

    it("stopping consumer cleans up", async () => {
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, counter) => {
          const events = Array.from({ length: demand }, (_, i) => counter + i);
          return [events, counter + demand];
        },
      });

      const consumer = Consumer.start(system, {
        handleEvents: (_events, _from, state) => state,
      });

      await consumer.subscribe(producer.getRef(), { maxDemand: 5 });
      await sleep(20);

      // Should not throw
      await consumer.stop();
      await sleep(20);
      await producer.stop();
    });
  });

  describe("ConsumerSupervisor", () => {
    const startFiniteProducer = (
      events: any[],
      options?: ProducerOptions,
    ): Producer => {
      return Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, cursor) => {
          const next = events.slice(cursor, cursor + demand);
          return [next, cursor + next.length];
        },
      }, options);
    };

    it("starts and stops cleanly", async () => {
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: TestWorker,
        args: [[]],
      });

      expect(supervisor.getRef()).toBeDefined();
      await supervisor.stop();
    });

    it("spawns a worker per event", async () => {
      const processed: number[] = [];
      const producer = startFiniteProducer([1, 2, 3, 4, 5]);
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: TestWorker,
        args: [processed],
      });

      await supervisor.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await waitFor(() => processed.length === 5);

      expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

      await supervisor.stop();
      await producer.stop();
    });

    it("worker receives event as last init arg", async () => {
      const received: Array<[string, number]> = [];
      const producer = startFiniteProducer([10, 11, 12]);
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: ArgsWorker,
        args: [received, "worker"],
      });

      await supervisor.subscribe(producer.getRef(), { maxDemand: 3, minDemand: 1 });
      await waitFor(() => received.length === 3);

      expect(received).toEqual([
        ["worker", 10],
        ["worker", 11],
        ["worker", 12],
      ]);

      await supervisor.stop();
      await producer.stop();
    });

    it("worker completion releases demand for more events", async () => {
      const processed: number[] = [];
      const allEvents = Array.from({ length: 20 }, (_, i) => i);
      const producer = startFiniteProducer(allEvents);
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: TestWorker,
        args: [processed],
      });

      await supervisor.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await waitFor(() => processed.length === 20);

      expect(processed.length).toBeGreaterThan(5);
      expect(processed.sort((a, b) => a - b)).toEqual(allEvents);

      await supervisor.stop();
      await producer.stop();
    });

    it("maxDemand limits concurrent workers", async () => {
      const counters = {
        current: { value: 0 },
        max: { value: 0 },
        done: [] as number[],
        delayMs: 30,
      };
      const events = Array.from({ length: 12 }, (_, i) => i);
      const producer = startFiniteProducer(events);
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: DelayWorker,
        args: [counters],
      });

      await supervisor.subscribe(producer.getRef(), { maxDemand: 3, minDemand: 1 });
      await waitFor(() => counters.done.length === events.length);

      expect(counters.max.value).toBeLessThanOrEqual(3);

      await supervisor.stop();
      await producer.stop();
    });

    it("whichChildren returns active workers", async () => {
      const started: number[] = [];
      const producer = startFiniteProducer([1, 2, 3]);
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: SlowWorker,
        args: [started],
      });

      await supervisor.subscribe(producer.getRef(), { maxDemand: 3, minDemand: 3 });
      await waitFor(() => started.length === 3);

      const children = await supervisor.whichChildren();
      expect(children).toHaveLength(3);
      for (const child of children) {
        expect(child.className).toBe("SlowWorker");
      }

      await supervisor.stop();
      await producer.stop();
    });

    it("countChildren returns correct counts", async () => {
      const started: number[] = [];
      const producer = startFiniteProducer([1, 2, 3, 4]);
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: SlowWorker,
        args: [started],
      });

      await supervisor.subscribe(producer.getRef(), { maxDemand: 4, minDemand: 4 });
      await waitFor(() => started.length === 4);

      const counts = await supervisor.countChildren();
      expect(counts).toEqual({ specs: 4, active: 4 });

      await supervisor.stop();
      await producer.stop();
    });

    it("cancel stops subscription", async () => {
      const started: number[] = [];
      const producer = Producer.start(system, {
        init: () => 0,
        handleDemand: (demand, cursor) => {
          const events = Array.from({ length: demand }, (_, i) => cursor + i);
          return [events, cursor + demand];
        },
      });
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: SlowWorker,
        args: [started],
      });

      const sub = await supervisor.subscribe(producer.getRef(), { maxDemand: 5, minDemand: 2 });
      await waitFor(() => started.length === 5);

      const beforeCancel = started.length;
      supervisor.cancel(sub);
      await sleep(60);

      expect(started.length).toBe(beforeCancel);

      await supervisor.stop();
      await producer.stop();
    });

    it("works with BroadcastDispatcher", async () => {
      const processed: number[] = [];
      const events = [0, 1, 2, 3, 4, 5];
      const producer = startFiniteProducer(events, { dispatcher: { type: "broadcast" } });
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: TestWorker,
        args: [processed],
      });

      await supervisor.subscribe(producer.getRef(), { maxDemand: 6, minDemand: 3 });
      await waitFor(() => processed.length === events.length);

      expect(processed.sort((a, b) => a - b)).toEqual(events);

      await supervisor.stop();
      await producer.stop();
    });

    it("works with PartitionDispatcher", async () => {
      const processed: number[] = [];
      const allEvents = Array.from({ length: 12 }, (_, i) => i);
      const producer = startFiniteProducer(allEvents, {
        dispatcher: {
          type: "partition",
          partitions: 2,
          hash: (event: number) => event % 2,
        },
      });
      const supervisor = ConsumerSupervisor.start(system, {
        actorClass: TestWorker,
        args: [processed],
      });

      await supervisor.subscribe(producer.getRef(), {
        maxDemand: 6,
        minDemand: 3,
        partition: 1,
      });
      await waitFor(() => processed.length > 0);
      await sleep(80);

      expect(processed.length).toBeGreaterThan(0);
      for (const event of processed) {
        expect(event % 2).toBe(1);
      }

      await supervisor.stop();
      await producer.stop();
    });
  });
});
