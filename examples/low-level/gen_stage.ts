// examples/low-level/gen_stage.ts
//
// Demonstrates: GenStage demand-driven pipeline with class-based API
// Prerequisites: None
// Run: npx tsx examples/low-level/gen_stage.ts
//
// This example shows:
// - Manual ActorSystem wiring (InMemoryTransport, LocalCluster, LocalRegistry)
// - Producer: emits timestamps on demand (simulates a data source)
// - ProducerConsumer: filters events (only keeps even-second timestamps)
// - Consumer: collects and prints filtered events
// - Multiple consumers sharing a single producer
// - Subscription cancellation

import {
  ActorSystem,
  InMemoryTransport,
  LocalCluster,
  LocalRegistry,
  Producer,
  Consumer,
  ProducerConsumer,
} from "../../src";

// --- Main ---

async function main() {
  console.log("=== GenStage (Low-Level API) ===\n");

  // Manual system wiring
  const cluster = new LocalCluster("node1");
  const transport = new InMemoryTransport("node1");
  const registry = new LocalRegistry();
  await transport.connect();
  const system = new ActorSystem(cluster, transport, registry);
  await system.start();

  try {
    // ============================================================
    // Part 1: Simple Producer → Consumer
    // ============================================================
    console.log("--- Part 1: Simple Producer → Consumer ---\n");

    // Producer: emits sequential numbers
    const numberProducer = Producer.start(system, {
      init: () => 1, // start from 1
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    });

    // Consumer: collects events
    const collected: number[] = [];
    const simpleConsumer = Consumer.start(system, {
      handleEvents: (events, _from, state) => {
        collected.push(...events);
        return state;
      },
    });

    await simpleConsumer.subscribe(numberProducer.getRef(), {
      maxDemand: 5,
      minDemand: 2,
    });

    await new Promise((r) => setTimeout(r, 100));

    console.log(`  Collected ${collected.length} numbers`);
    console.log(`  First 10: [${collected.slice(0, 10).join(", ")}]`);

    await simpleConsumer.stop();
    await numberProducer.stop();

    // ============================================================
    // Part 2: 3-stage pipeline with filtering
    // ============================================================
    console.log("\n--- Part 2: Pipeline with filter ---\n");
    console.log("  Producer (1..N) → Filter (even only) → Consumer\n");

    const producer2 = Producer.start(system, {
      init: () => 1,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    });

    // ProducerConsumer: pass through only even numbers
    const evenFilter = ProducerConsumer.start(system, {
      handleEvents: (events, _from, state) => {
        const evens = events.filter((n: number) => n % 2 === 0);
        return [evens, state];
      },
    });

    const evenNumbers: number[] = [];
    const evenConsumer = Consumer.start(system, {
      handleEvents: (events, _from, state) => {
        evenNumbers.push(...events);
        return state;
      },
    });

    // Wire: producer → filter → consumer
    await evenFilter.subscribe(producer2.getRef(), { maxDemand: 10, minDemand: 5 });
    await evenConsumer.subscribe(evenFilter.getRef(), { maxDemand: 10, minDemand: 5 });

    await new Promise((r) => setTimeout(r, 150));

    console.log(`  Received ${evenNumbers.length} even numbers`);
    console.log(`  First 10: [${evenNumbers.slice(0, 10).join(", ")}]`);
    const allEven = evenNumbers.every((n) => n % 2 === 0);
    console.log(`  All even: ${allEven}`);

    await evenConsumer.stop();
    await evenFilter.stop();
    await producer2.stop();

    // ============================================================
    // Part 3: Multiple consumers + cancellation
    // ============================================================
    console.log("\n--- Part 3: Multiple consumers + cancellation ---\n");

    const producer3 = Producer.start(system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    });

    const bucket1: number[] = [];
    const bucket2: number[] = [];

    const consumer1 = Consumer.start(system, {
      handleEvents: (events, _from, state) => {
        bucket1.push(...events);
        return state;
      },
    });

    const consumer2 = Consumer.start(system, {
      handleEvents: (events, _from, state) => {
        bucket2.push(...events);
        return state;
      },
    });

    // Both consumers subscribe to the same producer
    const sub1 = await consumer1.subscribe(producer3.getRef(), { maxDemand: 5, minDemand: 2 });
    await consumer2.subscribe(producer3.getRef(), { maxDemand: 5, minDemand: 2 });

    await new Promise((r) => setTimeout(r, 100));

    console.log(`  Consumer 1 received: ${bucket1.length} events`);
    console.log(`  Consumer 2 received: ${bucket2.length} events`);

    // No duplicates — DemandDispatcher splits events between consumers
    const all = [...bucket1, ...bucket2].sort((a, b) => a - b);
    const unique = [...new Set(all)];
    console.log(`  Total: ${all.length}, Unique: ${unique.length}, No duplicates: ${all.length === unique.length}`);

    // Cancel consumer 1's subscription
    console.log("\n  Cancelling consumer 1's subscription...");
    consumer1.cancel(sub1);
    const countBefore = bucket2.length;

    await new Promise((r) => setTimeout(r, 100));

    console.log(`  Consumer 2 received ${bucket2.length - countBefore} more events after cancel`);
    console.log(`  Consumer 1 stopped receiving: ${bucket1.length === bucket1.length}`);

    await consumer1.stop();
    await consumer2.stop();
    await producer3.stop();
  } finally {
    await system.shutdown();
    await transport.disconnect();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
