// examples/low-level/gen_stage.ts
//
// Demonstrates: GenStage demand-driven pipeline with class-based API and ConsumerSupervisor
// Prerequisites: None
// Run: npx tsx examples/low-level/gen_stage.ts
//
// This example shows:
// - Manual ActorSystem wiring (InMemoryTransport, LocalCluster, LocalRegistry)
// - DemandDispatcher: multiple consumers, cancellation
// - BroadcastDispatcher: all consumers get same events
// - PartitionDispatcher: hash-based routing with even/odd split
// - ProducerConsumer filtering pipeline
// - ConsumerSupervisor: spawn supervised class-based workers per event
// - ProducerConsumer filtering pipeline

import {
  Actor,
  ActorSystem,
  InMemoryTransport,
  LocalCluster,
  LocalRegistry,
  Producer,
  Consumer,
  ProducerConsumer,
  ConsumerSupervisor,
} from "../../src";

// --- Worker Actor (class-based) ---

class TaskWorker extends Actor {
  init(results: number[], taskId: number) {
    results.push(taskId);
    // Worker processes the task and stops itself
    setTimeout(() => void this.context.system.stop(this.self), 1);
  }
  handleCall() { return undefined; }
  handleCast() {}
}

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
    // Part 1: DemandDispatcher — multiple consumers + cancellation
    // ============================================================
    console.log("--- Part 1: DemandDispatcher (multiple consumers) ---\n");

    const producer1 = Producer.start(system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    });

    const bucket1: number[] = [];
    const bucket2: number[] = [];

    const c1 = Consumer.start(system, {
      handleEvents: (events, _from, state) => { bucket1.push(...events); return state; },
    });
    const c2 = Consumer.start(system, {
      handleEvents: (events, _from, state) => { bucket2.push(...events); return state; },
    });

    const sub1 = await c1.subscribe(producer1.getRef(), { maxDemand: 5, minDemand: 2 });
    await c2.subscribe(producer1.getRef(), { maxDemand: 5, minDemand: 2 });
    await new Promise((r) => setTimeout(r, 100));

    console.log(`  Consumer 1: ${bucket1.length} events, Consumer 2: ${bucket2.length} events`);
    const all = [...bucket1, ...bucket2].sort((a, b) => a - b);
    console.log(`  No duplicates: ${all.length === new Set(all).size}`);

    // Cancel consumer 1
    c1.cancel(sub1);
    const beforeCancel = bucket2.length;
    await new Promise((r) => setTimeout(r, 50));
    console.log(`  After cancel: Consumer 2 got ${bucket2.length - beforeCancel} more events`);

    await c1.stop();
    await c2.stop();
    await producer1.stop();

    // ============================================================
    // Part 2: Pipeline with ProducerConsumer filter
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

    const evenFilter = ProducerConsumer.start(system, {
      handleEvents: (events, _from, state) => {
        const evens = events.filter((n: number) => n % 2 === 0);
        return [evens, state];
      },
    });

    const evenNumbers: number[] = [];
    const evenConsumer = Consumer.start(system, {
      handleEvents: (events, _from, state) => { evenNumbers.push(...events); return state; },
    });

    await evenFilter.subscribe(producer2.getRef(), { maxDemand: 10, minDemand: 5 });
    await evenConsumer.subscribe(evenFilter.getRef(), { maxDemand: 10, minDemand: 5 });
    await new Promise((r) => setTimeout(r, 150));

    console.log(`  Received ${evenNumbers.length} even numbers`);
    console.log(`  First 10: [${evenNumbers.slice(0, 10).join(", ")}]`);
    console.log(`  All even: ${evenNumbers.every((n) => n % 2 === 0)}`);

    await evenConsumer.stop();
    await evenFilter.stop();
    await producer2.stop();

    // ============================================================
    // Part 3: BroadcastDispatcher — fan-out
    // ============================================================
    console.log("\n--- Part 3: BroadcastDispatcher (fan-out) ---\n");

    const broadcastProducer = Producer.start(system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    }, { dispatcher: { type: "broadcast" } });

    const fanA: number[] = [];
    const fanB: number[] = [];

    const cA = Consumer.start(system, {
      handleEvents: (events, _from, state) => { fanA.push(...events); return state; },
    });
    const cB = Consumer.start(system, {
      handleEvents: (events, _from, state) => { fanB.push(...events); return state; },
    });

    await Promise.all([
      cA.subscribe(broadcastProducer.getRef(), { maxDemand: 10, minDemand: 5 }),
      cB.subscribe(broadcastProducer.getRef(), { maxDemand: 10, minDemand: 5 }),
    ]);
    await new Promise((r) => setTimeout(r, 150));

    console.log(`  Consumer A: ${fanA.length} events`);
    console.log(`  Consumer B: ${fanB.length} events`);
    console.log(`  Same first 5: ${fanA.slice(0, 5).join(",") === fanB.slice(0, 5).join(",")}`);
    console.log(`  Values: [${fanA.slice(0, 5).join(", ")}]`);

    await cA.stop();
    await cB.stop();
    await broadcastProducer.stop();

    // ============================================================
    // Part 4: PartitionDispatcher — hash-based routing
    // ============================================================
    console.log("\n--- Part 4: PartitionDispatcher (sharding) ---\n");
    console.log("  Hash: event % 3 → partitions 0, 1, 2\n");

    const partProducer = Producer.start(system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    }, {
      dispatcher: {
        type: "partition",
        partitions: 3,
        hash: (e: number) => e % 3,
      },
    });

    const p0: number[] = [];
    const p1: number[] = [];
    const p2: number[] = [];

    const cp0 = Consumer.start(system, {
      handleEvents: (events, _from, state) => { p0.push(...events); return state; },
    });
    const cp1 = Consumer.start(system, {
      handleEvents: (events, _from, state) => { p1.push(...events); return state; },
    });
    const cp2 = Consumer.start(system, {
      handleEvents: (events, _from, state) => { p2.push(...events); return state; },
    });

    await cp0.subscribe(partProducer.getRef(), { maxDemand: 10, minDemand: 5, partition: 0 });
    await cp1.subscribe(partProducer.getRef(), { maxDemand: 10, minDemand: 5, partition: 1 });
    await cp2.subscribe(partProducer.getRef(), { maxDemand: 10, minDemand: 5, partition: 2 });
    await new Promise((r) => setTimeout(r, 150));

    console.log(`  Partition 0 (n%3=0): ${p0.length} events → [${p0.slice(0, 5).join(", ")}]`);
    console.log(`  Partition 1 (n%3=1): ${p1.length} events → [${p1.slice(0, 5).join(", ")}]`);
    console.log(`  Partition 2 (n%3=2): ${p2.length} events → [${p2.slice(0, 5).join(", ")}]`);
    console.log(`  All correct: P0=${p0.every((n) => n % 3 === 0)}, P1=${p1.every((n) => n % 3 === 1)}, P2=${p2.every((n) => n % 3 === 2)}`);

    await cp0.stop();
    await cp1.stop();
    await cp2.stop();
    await partProducer.stop();

    // ============================================================
    // Part 5: ConsumerSupervisor — class-based workers
    // ============================================================
    console.log("\n--- Part 5: ConsumerSupervisor (class-based workers) ---\n");
    console.log("  Producer → ConsumerSupervisor → [TaskWorker per event]\n");


    const taskResults: number[] = [];

    const taskProducer = Producer.start(system, {
      init: () => 0,
      handleDemand: (demand, counter) => {
        const events = Array.from({ length: demand }, (_, i) => counter + i);
        return [events, counter + demand];
      },
    });

    const taskSupervisor = ConsumerSupervisor.start(system, {
      actorClass: TaskWorker,
      args: [taskResults],  // taskId (event) appended as last arg
    });

    await taskSupervisor.subscribe(taskProducer.getRef(), { maxDemand: 8, minDemand: 5 });
    await new Promise((r) => setTimeout(r, 300));

    const sorted = taskResults.sort((a, b) => a - b);
    console.log(`  Tasks completed: ${taskResults.length}`);
    console.log(`  First 10: [${sorted.slice(0, 10).join(", ")}]`);
    console.log(`  All sequential: ${sorted.slice(0, 10).every((v, i) => v === i)}`);

    const taskCounts = await taskSupervisor.countChildren();
    console.log(`  Active workers: ${taskCounts.active}`);

    await taskSupervisor.stop();
    await taskProducer.stop();
  } finally {
    await system.shutdown();
    await transport.disconnect();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
