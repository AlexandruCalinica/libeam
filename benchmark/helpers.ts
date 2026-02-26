import {
  Actor,
  ActorSystem,
  InMemoryTransport,
  LocalRegistry,
  Cluster,
  loggerConfig,
} from "../src";
import {
  Producer,
  Consumer,
  ConsumerSupervisor,
  ProducerConsumer,
  ProducerOptions,
} from "../src/gen_stage";

// Silence logs during benchmarks
loggerConfig.level = "none";

// ============ System Factory ============

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

export async function createBenchSystem(): Promise<ActorSystem> {
  const cluster = new MockCluster("bench-node");
  const transport = new InMemoryTransport(cluster.nodeId);
  const registry = new LocalRegistry();
  const system = new ActorSystem(cluster, transport, registry);
  await system.start();
  return system;
}

// ============ Event Tracking ============

export interface EventTracker {
  handleEvents: (events: any[], from: any, state: any) => any;
  done: Promise<void>;
}

/**
 * Shared event counter across consumers.
 * Resolves `done` when total events received reaches `expectedTotal`.
 *
 * For DemandDispatcher / PartitionDispatcher: expectedTotal = totalEvents
 * For BroadcastDispatcher: expectedTotal = totalEvents * consumerCount
 */
export function createTracker(expectedTotal: number): EventTracker {
  let resolve: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  let received = 0;

  return {
    handleEvents: (events: any[], _from: any, state: any) => {
      received += events.length;
      if (received >= expectedTotal) resolve!();
      return state;
    },
    done,
  };
}

// ============ Worker Tracking (ConsumerSupervisor) ============

export interface WorkerTracker {
  received: number;
  total: number;
  resolve: () => void;
  done: Promise<void>;
}

/**
 * Shared counter for ConsumerSupervisor workers.
 * Each worker increments `received` in init, resolves `done` when target reached.
 */
export function createWorkerTracker(expectedTotal: number): WorkerTracker {
  let _resolve: () => void;
  const done = new Promise<void>((r) => {
    _resolve = r;
  });

  return {
    received: 0,
    total: expectedTotal,
    resolve() {
      _resolve();
    },
    done,
  };
}

/** Minimal worker that counts initialization and exits immediately. */
export class BenchWorker extends Actor {
  init(tracker: WorkerTracker, _event: any) {
    tracker.received++;
    if (tracker.received >= tracker.total) tracker.resolve();
    setTimeout(() => {
      void this.context.system.stop(this.self);
    }, 0);
  }

  handleCall(): undefined {
    return undefined;
  }

  handleCast(): void {}
}

// ============ Stage Factories ============

/**
 * Producer that emits exactly `totalEvents` sequential integers.
 * Returns empty array once all events have been emitted.
 */
export function createFiniteProducer(
  system: ActorSystem,
  totalEvents: number,
  options?: ProducerOptions,
): Producer {
  return Producer.start(
    system,
    {
      init: () => 0,
      handleDemand: (demand: number, counter: number): [any[], number] => {
        const remaining = totalEvents - counter;
        if (remaining <= 0) return [[], counter];
        const count = Math.min(demand, remaining);
        const events = Array.from({ length: count }, (_, i) => counter + i);
        return [events, counter + count];
      },
    },
    options,
  );
}

/** Create N consumers sharing the same event tracker. */
export function createConsumers(
  system: ActorSystem,
  count: number,
  tracker: EventTracker,
): Consumer[] {
  return Array.from({ length: count }, () =>
    Consumer.start(system, { handleEvents: tracker.handleEvents }),
  );
}

/** Pass-through ProducerConsumer — forwards events unchanged. */
export function createPassthroughPC(
  system: ActorSystem,
  producerOptions?: ProducerOptions,
): ProducerConsumer {
  return ProducerConsumer.start(
    system,
    {
      init: () => null,
      handleEvents: (events: any[], _from: any, state: any): [any[], any] => {
        return [events, state];
      },
    },
    producerOptions,
  );
}

/** Stop multiple stages in parallel. */
export async function stopAll(
  ...stages: Array<{ stop: () => Promise<void> }>
): Promise<void> {
  await Promise.all(stages.map((s) => s.stop()));
}
