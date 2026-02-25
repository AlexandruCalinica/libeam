// examples/high-level/gen_stage.ts
//
// Demonstrates: Demand-driven producer-consumer pipelines with back-pressure
// Run: npx tsx examples/high-level/gen_stage.ts
//
// This example shows:
// - DemandDispatcher: default highest-demand-first routing
// - BroadcastDispatcher: all consumers get all events
// - PartitionDispatcher: hash-based routing to specific consumers
// - 3-stage pipeline: Producer → Multiplier → Consumer
// - Back-pressure: consumers control event flow via demand
//
// GenStage implements Elixir's demand protocol: consumers tell producers
// how many events they can handle, and producers never emit more than
// requested. This prevents fast producers from overwhelming slow consumers.

import { createSystem, Producer, Consumer, ProducerConsumer } from "../../src";

// --- Main ---

async function main() {
  console.log("=== GenStage Pipeline ===\n");
  const system = createSystem();

  try {
    // ============================================================
    // Part 1: DemandDispatcher (default) — 3-stage pipeline
    // ============================================================
    console.log("--- Part 1: DemandDispatcher (3-stage pipeline) ---\n");
    console.log("  Producer (numbers) → Multiplier (×10) → Consumer\n");

    const producer = Producer.start(system.system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    });

    const multiplier = ProducerConsumer.start(system.system, {
      init: () => 10,
      handleEvents: (events, _from, factor) => {
        const transformed = events.map((n: number) => n * factor);
        return [transformed, factor];
      },
    });

    const received: number[] = [];
    const consumer = Consumer.start(system.system, {
      handleEvents: (events, _from, state) => {
        received.push(...events);
        return state;
      },
    });

    await multiplier.subscribe(producer.getRef(), { maxDemand: 10, minDemand: 5 });
    await consumer.subscribe(multiplier.getRef(), { maxDemand: 10, minDemand: 5 });
    await new Promise((r) => setTimeout(r, 200));

    console.log(`  Total events: ${received.length}`);
    console.log(`  First 10: [${received.slice(0, 10).join(", ")}]`);
    console.log(`  Expected: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]`);
    const correct = received.slice(0, 10).every((v, i) => v === [0, 10, 20, 30, 40, 50, 60, 70, 80, 90][i]);
    console.log(`  Correct: ${correct}`);

    await consumer.stop();
    await multiplier.stop();
    await producer.stop();

    // ============================================================
    // Part 2: BroadcastDispatcher — all consumers get all events
    // ============================================================
    console.log("\n--- Part 2: BroadcastDispatcher (fan-out) ---\n");
    console.log("  Producer → [Consumer A, Consumer B] (both get same events)\n");

    const broadcastProducer = Producer.start(system.system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    }, { dispatcher: { type: "broadcast" } });

    const bucketA: number[] = [];
    const bucketB: number[] = [];

    const consumerA = Consumer.start(system.system, {
      handleEvents: (events, _from, state) => { bucketA.push(...events); return state; },
    });
    const consumerB = Consumer.start(system.system, {
      handleEvents: (events, _from, state) => { bucketB.push(...events); return state; },
    });

    // Both subscribe — demand = min(10, 10) = 10
    await Promise.all([
      consumerA.subscribe(broadcastProducer.getRef(), { maxDemand: 10, minDemand: 5 }),
      consumerB.subscribe(broadcastProducer.getRef(), { maxDemand: 10, minDemand: 5 }),
    ]);
    await new Promise((r) => setTimeout(r, 150));

    console.log(`  Consumer A received: ${bucketA.length} events`);
    console.log(`  Consumer B received: ${bucketB.length} events`);
    const sameEvents = bucketA.slice(0, 10).every((v, i) => v === bucketB[i]);
    console.log(`  Same events: ${sameEvents}`);
    console.log(`  First 5 (A): [${bucketA.slice(0, 5).join(", ")}]`);
    console.log(`  First 5 (B): [${bucketB.slice(0, 5).join(", ")}]`);

    await consumerA.stop();
    await consumerB.stop();
    await broadcastProducer.stop();

    // ============================================================
    // Part 3: PartitionDispatcher — hash-based routing
    // ============================================================
    console.log("\n--- Part 3: PartitionDispatcher (sharding) ---\n");
    console.log("  Producer → [Partition 0 (evens), Partition 1 (odds)]\n");

    const partProducer = Producer.start(system.system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    }, {
      dispatcher: {
        type: "partition",
        partitions: 2,
        hash: (event: number) => event % 2, // even→0, odd→1
      },
    });

    const evens: number[] = [];
    const odds: number[] = [];

    const evenConsumer = Consumer.start(system.system, {
      handleEvents: (events, _from, state) => { evens.push(...events); return state; },
    });
    const oddConsumer = Consumer.start(system.system, {
      handleEvents: (events, _from, state) => { odds.push(...events); return state; },
    });

    await evenConsumer.subscribe(partProducer.getRef(), { maxDemand: 10, minDemand: 5, partition: 0 });
    await oddConsumer.subscribe(partProducer.getRef(), { maxDemand: 10, minDemand: 5, partition: 1 });
    await new Promise((r) => setTimeout(r, 150));

    console.log(`  Partition 0 (evens): ${evens.length} events`);
    console.log(`  Partition 1 (odds):  ${odds.length} events`);
    console.log(`  First 5 evens: [${evens.slice(0, 5).join(", ")}]`);
    console.log(`  First 5 odds:  [${odds.slice(0, 5).join(", ")}]`);
    const allEvensCorrect = evens.every((n) => n % 2 === 0);
    const allOddsCorrect = odds.every((n) => n % 2 === 1);
    console.log(`  All evens correct: ${allEvensCorrect}`);
    console.log(`  All odds correct: ${allOddsCorrect}`);

    await evenConsumer.stop();
    await oddConsumer.stop();
    await partProducer.stop();
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
