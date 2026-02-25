// examples/high-level/gen_stage.ts
//
// Demonstrates: Demand-driven producer-consumer pipelines with back-pressure
// Run: npx tsx examples/high-level/gen_stage.ts
//
// This example shows:
// - Producer emitting sequential numbers on demand
// - ProducerConsumer transforming events (multiply by 10)
// - Consumer receiving and printing events
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
    // --- Stage 1: Producer ---
    // Generates sequential numbers on demand.
    // handleDemand(demand, state) returns [events, newState].
    console.log("--- Setting up 3-stage pipeline ---\n");
    console.log("  Producer (numbers) → Multiplier (×10) → Consumer (print)\n");

    const producer = Producer.start(system.system, {
      init: () => 0, // state = next number to emit
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    });

    // --- Stage 2: ProducerConsumer (transformer) ---
    // Receives events from upstream, transforms them, emits downstream.
    // handleEvents(events, from, state) returns [outputEvents, newState].
    const multiplier = ProducerConsumer.start(system.system, {
      init: () => 10, // multiplication factor
      handleEvents: (events, _from, factor) => {
        const transformed = events.map((n: number) => n * factor);
        return [transformed, factor];
      },
    });

    // --- Stage 3: Consumer ---
    // Receives and processes events. handleEvents returns new state.
    const received: number[] = [];

    const consumer = Consumer.start(system.system, {
      handleEvents: (events, _from, state) => {
        received.push(...events);
        return state;
      },
    });

    // --- Wire the pipeline ---
    // Subscribe creates a demand link: consumer → producer.
    // maxDemand: max events in flight per subscription.
    // minDemand: when pending demand drops to this, consumer re-asks.
    console.log("--- Subscribing stages ---\n");

    await multiplier.subscribe(producer.getRef(), {
      maxDemand: 10,
      minDemand: 5,
    });

    await consumer.subscribe(multiplier.getRef(), {
      maxDemand: 10,
      minDemand: 5,
    });

    // Let the pipeline process for a bit
    await new Promise((r) => setTimeout(r, 200));

    // --- Results ---
    console.log("--- Results ---\n");
    console.log(`  Total events received: ${received.length}`);
    console.log(`  First 10 events: [${received.slice(0, 10).join(", ")}]`);
    console.log(`  Expected first 10: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]`);
    console.log(`  (Original numbers 0-9 multiplied by 10)\n`);

    // Verify correctness
    const first10 = received.slice(0, 10);
    const expected = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    const correct = first10.every((v, i) => v === expected[i]);
    console.log(`  Pipeline correct: ${correct}`);

    // --- Demonstrate back-pressure ---
    console.log("\n--- Back-pressure ---\n");
    console.log(`  maxDemand=10 means consumer asks for 10 at a time`);
    console.log(`  minDemand=5 means consumer re-asks when only 5 pending`);
    console.log(`  Producer never emits more than total demand from all consumers`);
    console.log(`  → Fast producer cannot overwhelm slow consumer`);

    // Clean up stages
    await consumer.stop();
    await multiplier.stop();
    await producer.stop();
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
