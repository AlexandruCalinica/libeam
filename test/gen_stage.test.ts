import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ActorSystem, InMemoryTransport, LocalRegistry, Cluster,
} from "../src";
import { Producer, Consumer, ProducerConsumer } from "../src/gen_stage";

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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
});
