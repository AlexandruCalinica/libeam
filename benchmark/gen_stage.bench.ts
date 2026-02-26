import { bench, describe } from "vitest";
import { ActorSystem } from "../src";
import { ConsumerSupervisor } from "../src/gen_stage";
import {
  createBenchSystem,
  createFiniteProducer,
  createTracker,
  createConsumers,
  createPassthroughPC,
  createWorkerTracker,
  BenchWorker,
  stopAll,
} from "./helpers";

const EVENTS = 10_000;
const EVENTS_BROADCAST = 2_000; // Broadcast sends to ALL consumers — N×2k total
const EVENTS_SUP = 200; // ConsumerSupervisor (spawn overhead dominates)

// Lazy singleton — created once, reused across all benches in this file.
// vitest bench does not support beforeAll/afterAll hooks, so we use this pattern.
let _system: ActorSystem | null = null;
async function getSystem(): Promise<ActorSystem> {
  if (!_system) _system = await createBenchSystem();
  return _system;
}

// Minimal overhead: 1 warmup iteration, 1s measurement.
// 22 benches × ~1.5s ≈ 30s total runtime.
const opts = { time: 1000, warmupIterations: 1, warmupTime: 100 };

// ============================================================
//  Baseline: Producer → Consumer
// ============================================================

describe("Baseline: Producer → Consumer", () => {
  for (const maxDemand of [100, 1000]) {
    const minDemand = Math.floor(maxDemand * 0.75);

    bench(`${EVENTS} events, maxDemand=${maxDemand}`, async () => {
        const system = await getSystem();
        const tracker = createTracker(EVENTS);
        const producer = createFiniteProducer(system, EVENTS);
        const [consumer] = createConsumers(system, 1, tracker);
        await consumer.subscribe(producer.getRef(), { maxDemand, minDemand });
        await tracker.done;
        await stopAll(producer, consumer);
      },
      opts,
    );
  }
});

// ============================================================
//  Fan-out: DemandDispatcher (events distributed across consumers)
// ============================================================

describe("Fan-out: DemandDispatcher", () => {
  for (const N of [1, 2, 4, 8]) {
    bench(
      `${EVENTS} events → ${N} consumer(s)`,
      async () => {
        const system = await getSystem();
        const tracker = createTracker(EVENTS);
        const producer = createFiniteProducer(system, EVENTS);
        const consumers = createConsumers(system, N, tracker);

        for (const c of consumers) {
          await c.subscribe(producer.getRef(), {
            maxDemand: 100,
            minDemand: 75,
          });
        }

        await tracker.done;
        await stopAll(producer, ...consumers);
      },
      opts,
    );
  }
});

// ============================================================
//  Fan-out: BroadcastDispatcher (all consumers get all events)
// ============================================================

describe("Fan-out: BroadcastDispatcher", () => {
  for (const N of [1, 2, 4, 8]) {
    bench(
      `${EVENTS_BROADCAST} events → ${N} consumer(s)`,
      async () => {
        const system = await getSystem();
        // Each consumer receives ALL events → total = EVENTS_BROADCAST * N
        const tracker = createTracker(EVENTS_BROADCAST * N);
        const producer = createFiniteProducer(system, EVENTS_BROADCAST, {
          dispatcher: { type: "broadcast" },
        });
        const consumers = createConsumers(system, N, tracker);

        // Promise.all subscribe — prevents BroadcastDispatcher race condition
        // where early subscribers receive events before all are registered.
        await Promise.all(consumers.map(c =>
          c.subscribe(producer.getRef(), { maxDemand: 100, minDemand: 75 })
        ));

        await tracker.done;
        await stopAll(producer, ...consumers);
      },
      opts,
    );
  }
});

// ============================================================
//  Routing: PartitionDispatcher (hash-based routing)
// ============================================================

describe("Routing: PartitionDispatcher", () => {
  for (const N of [2, 4, 8]) {
    bench(`${EVENTS} events → ${N} partitions`, async () => {
        const system = await getSystem();
        const tracker = createTracker(EVENTS);
        const producer = createFiniteProducer(system, EVENTS, {
          dispatcher: {
            type: "partition",
            partitions: N,
            hash: (event: number) => event % N,
          },
        });
        const consumers = createConsumers(system, N, tracker);

        for (let p = 0; p < N; p++) {
          await consumers[p].subscribe(producer.getRef(), {
            maxDemand: 100,
            minDemand: 75,
            partition: p,
          });
        }

        await tracker.done;
        await stopAll(producer, ...consumers);
      },
      opts,
    );
  }
});

// ============================================================
//  Pipeline Depth: Producer → [ProducerConsumer]* → Consumer
// ============================================================

describe("Pipeline depth", () => {
  const subOpts = { maxDemand: 100, minDemand: 75 };

  bench(`${EVENTS} events: P → C (1 hop)`, async () => {
      const system = await getSystem();
      const tracker = createTracker(EVENTS);
      const producer = createFiniteProducer(system, EVENTS);
      const [consumer] = createConsumers(system, 1, tracker);

      await consumer.subscribe(producer.getRef(), subOpts);
      await tracker.done;
      await stopAll(producer, consumer);
    },
    opts,
  );

  bench(`${EVENTS} events: P → PC → C (2 hops)`, async () => {
      const system = await getSystem();
      const tracker = createTracker(EVENTS);
      const producer = createFiniteProducer(system, EVENTS);
      const pc = createPassthroughPC(system);
      const [consumer] = createConsumers(system, 1, tracker);

      await pc.subscribe(producer.getRef(), subOpts);
      await consumer.subscribe(pc.getRef(), subOpts);
      await tracker.done;
      await stopAll(producer, pc, consumer);
    },
    opts,
  );

  bench(`${EVENTS} events: P → PC → PC → C (3 hops)`, async () => {
      const system = await getSystem();
      const tracker = createTracker(EVENTS);
      const producer = createFiniteProducer(system, EVENTS);
      const pc1 = createPassthroughPC(system);
      const pc2 = createPassthroughPC(system);
      const [consumer] = createConsumers(system, 1, tracker);

      await pc1.subscribe(producer.getRef(), subOpts);
      await pc2.subscribe(pc1.getRef(), subOpts);
      await consumer.subscribe(pc2.getRef(), subOpts);
      await tracker.done;
      await stopAll(producer, pc1, pc2, consumer);
    },
    opts,
  );
});

// ============================================================
//  ConsumerSupervisor (worker spawn overhead)
// ============================================================

describe("ConsumerSupervisor", () => {
  for (const maxDemand of [5, 10, 20]) {
    const minDemand = Math.floor(maxDemand * 0.75);

    bench(
      `${EVENTS_SUP} events, maxDemand=${maxDemand} (spawn+exit per event)`,
      async () => {
        const system = await getSystem();
        const workerTracker = createWorkerTracker(EVENTS_SUP);
        const producer = createFiniteProducer(system, EVENTS_SUP);
        const supervisor = ConsumerSupervisor.start(system, {
          actorClass: BenchWorker,
          args: [workerTracker],
        });

        await supervisor.subscribe(producer.getRef(), {
          maxDemand,
          minDemand,
        });
        await workerTracker.done;
        await stopAll(producer, supervisor);
      },
      opts,
    );
  }
});

// ============================================================
//  Dispatcher Comparison (same load, 4 consumers each)
// ============================================================

describe("Dispatcher comparison: 4 consumers", () => {
  const N = 4;
  const subOpts = { maxDemand: 100, minDemand: 75 };

  bench("DemandDispatcher", async () => {
      const system = await getSystem();
      const tracker = createTracker(EVENTS);
      const producer = createFiniteProducer(system, EVENTS);
      const consumers = createConsumers(system, N, tracker);

      for (const c of consumers) {
        await c.subscribe(producer.getRef(), subOpts);
      }
      await tracker.done;
      await stopAll(producer, ...consumers);
    },
    opts,
  );

  bench("BroadcastDispatcher", async () => {
      const system = await getSystem();
      const tracker = createTracker(EVENTS_BROADCAST * N);
      const producer = createFiniteProducer(system, EVENTS_BROADCAST, {
        dispatcher: { type: "broadcast" },
      });
      const consumers = createConsumers(system, N, tracker);

      await Promise.all(consumers.map(c =>
        c.subscribe(producer.getRef(), subOpts)
      ));
      await tracker.done;
      await stopAll(producer, ...consumers);
    },
    opts,
  );

  bench("PartitionDispatcher", async () => {
      const system = await getSystem();
      const tracker = createTracker(EVENTS);
      const producer = createFiniteProducer(system, EVENTS, {
        dispatcher: {
          type: "partition",
          partitions: N,
          hash: (event: number) => event % N,
        },
      });
      const consumers = createConsumers(system, N, tracker);

      for (let p = 0; p < N; p++) {
        await consumers[p].subscribe(producer.getRef(), {
          ...subOpts,
          partition: p,
        });
      }
      await tracker.done;
      await stopAll(producer, ...consumers);
    },
    opts,
  );
});
