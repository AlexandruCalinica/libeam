import { bench, describe } from "vitest";
import { Actor, ActorRef, ActorSystem } from "../src";
import { createBenchSystem } from "./helpers";

const CALLS = 10_000;
const CALLS_CONTENTION = 5_000;

// Lazy singleton — created once, reused across all benches.
let _system: ActorSystem | null = null;
async function getSystem(): Promise<ActorSystem> {
  if (!_system) _system = await createBenchSystem();
  return _system;
}

const opts = { time: 1000, warmupIterations: 1, warmupTime: 100 };

// ============================================================
//  Actors
// ============================================================

class CounterActor extends Actor<{ type: "increment" }, { type: "get" | "increment" }, number> {
  private count = 0;

  handleCall(message: { type: "get" | "increment" }): number {
    if (message.type === "increment") {
      return ++this.count;
    }
    return this.count;
  }

  handleCast(message: { type: "increment" }): void {
    this.count++;
  }
}

class EchoActor extends Actor<never, any, any> {
  handleCall(message: any): any {
    return message;
  }

  handleCast(): void {}
}

// ============================================================
//  Sequential Calls: One caller → one actor, serial
// ============================================================

describe("Sequential calls: 1 caller → 1 actor", () => {
  bench(
    `${CALLS} sequential calls`,
    async () => {
      const system = await getSystem();
      const ref = system.spawn(CounterActor);
      for (let i = 0; i < CALLS; i++) {
        await ref.call({ type: "increment" });
      }
      await system.stop(ref);
    },
    opts,
  );

  bench(
    `${CALLS} sequential echo calls (pass-through)`,
    async () => {
      const system = await getSystem();
      const ref = system.spawn(EchoActor);
      for (let i = 0; i < CALLS; i++) {
        await ref.call(i);
      }
      await system.stop(ref);
    },
    opts,
  );
});

// ============================================================
//  Parallel Calls: One caller → N actors, parallel batches
// ============================================================

describe("Parallel calls: fan-out to N actors", () => {
  for (const N of [1, 4, 8, 16]) {
    bench(
      `${CALLS} calls → ${N} actor(s), batches of ${N}`,
      async () => {
        const system = await getSystem();
        const actors: ActorRef[] = [];
        for (let i = 0; i < N; i++) {
          actors.push(system.spawn(EchoActor));
        }
        const callsPerActor = Math.floor(CALLS / N);
        for (let i = 0; i < callsPerActor; i++) {
          await Promise.all(actors.map((ref) => ref.call(i)));
        }
        await Promise.all(actors.map((ref) => system.stop(ref)));
      },
      opts,
    );
  }
});

// ============================================================
//  Contention: N callers → 1 actor, all in flight
// ============================================================

describe("Contention: N callers → 1 actor", () => {
  for (const N of [10, 50, 100]) {
    bench(
      `${CALLS_CONTENTION} calls, ${N} in-flight at a time`,
      async () => {
        const system = await getSystem();
        const ref = system.spawn(EchoActor);
        let completed = 0;

        while (completed < CALLS_CONTENTION) {
          const batch = Math.min(N, CALLS_CONTENTION - completed);
          const promises: Promise<any>[] = [];
          for (let i = 0; i < batch; i++) {
            promises.push(ref.call(completed + i));
          }
          await Promise.all(promises);
          completed += batch;
        }

        await system.stop(ref);
      },
      opts,
    );
  }
});

// ============================================================
//  Call chain: A calls B calls C (nested calls)
// ============================================================

class ForwarderActor extends Actor {
  private target!: ActorRef;

  init(target: ActorRef) {
    this.target = target;
  }

  handleCall(message: any): Promise<any> {
    return this.target.call(message);
  }

  handleCast(): void {}
}

describe("Call chain depth", () => {
  bench(
    `${CALLS} calls: A → B (1 hop)`,
    async () => {
      const system = await getSystem();
      const echo = system.spawn(EchoActor);
      const forwarder = system.spawn(ForwarderActor, { args: [echo] });
      for (let i = 0; i < CALLS; i++) {
        await forwarder.call(i);
      }
      await system.stop(forwarder);
      await system.stop(echo);
    },
    opts,
  );

  bench(
    `${CALLS} calls: A → B → C (2 hops)`,
    async () => {
      const system = await getSystem();
      const echo = system.spawn(EchoActor);
      const mid = system.spawn(ForwarderActor, { args: [echo] });
      const front = system.spawn(ForwarderActor, { args: [mid] });
      for (let i = 0; i < CALLS; i++) {
        await front.call(i);
      }
      await system.stop(front);
      await system.stop(mid);
      await system.stop(echo);
    },
    opts,
  );
});

// ============================================================
//  Mixed workload: calls + casts interleaved
// ============================================================

describe("Mixed: calls + casts interleaved", () => {
  bench(
    `${CALLS} ops (50/50 call/cast)`,
    async () => {
      const system = await getSystem();
      const ref = system.spawn(CounterActor);
      for (let i = 0; i < CALLS; i++) {
        if (i % 2 === 0) {
          await ref.call({ type: "increment" });
        } else {
          ref.cast({ type: "increment" });
        }
      }
      // Final call to ensure all casts are flushed
      await ref.call({ type: "get" });
      await system.stop(ref);
    },
    opts,
  );
});
