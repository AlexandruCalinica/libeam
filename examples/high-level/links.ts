// examples/high-level/links.ts
//
// Demonstrates: Bidirectional crash propagation (link, unlink, trapExit)
// Run: npx tsx examples/high-level/links.ts

import { createSystem, createActor, ActorRef, ExitMessage, LinkRef } from "../../src";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Worker = createActor((ctx, self, name: string) => {
  console.log(`  [${name}] Started`);
  self
    .cast("crash", () => {
      console.log(`  [${name}] Crashing!`);
      throw new Error(`${name} crashed`);
    })
    .onTerminate(() => {
      console.log(`  [${name}] Terminated`);
    });
});

const Coordinator = createActor((ctx, self, name: string) => {
  const linked = new Map<string, { ref: ActorRef; linkRef: LinkRef }>();
  console.log(`  [Coord:${name}] Started`);

  self
    .call("getLinked", () => Array.from(linked.keys()))
    .cast("linkWorker", (id: string, ref: ActorRef) => {
      const linkRef = ctx.link(ref);
      linked.set(id, { ref, linkRef });
      console.log(`  [Coord:${name}] Linked to ${id}`);
    })
    .cast("unlinkWorker", (id: string) => {
      const entry = linked.get(id);
      if (entry) {
        ctx.unlink(entry.linkRef);
        linked.delete(id);
        console.log(`  [Coord:${name}] Unlinked from ${id}`);
      }
    })
    .onTerminate(() => {
      console.log(`  [Coord:${name}] Terminated`);
    });
});

const Supervisor = createActor((ctx, self, name: string) => {
  const workers = new Map<string, ActorRef>();
  const exitLog: Array<{ id: string; reason: string }> = [];

  ctx.setTrapExit(true);
  console.log(`  [Sup:${name}] Started (trapExit=true)`);

  self
    .call("getWorkers", () => Array.from(workers.keys()))
    .call("getExitLog", () => [...exitLog])
    .cast("linkWorker", (id: string, ref: ActorRef) => {
      ctx.link(ref);
      workers.set(id, ref);
      console.log(`  [Sup:${name}] Linked to ${id}`);
    })
    .info("exit", (msg: ExitMessage) => {
      let workerId = "unknown";
      for (const [id, ref] of workers.entries()) {
        if (ref.id.id === msg.actorRef.id.id) {
          workerId = id;
          workers.delete(id);
          break;
        }
      }
      exitLog.push({ id: workerId, reason: msg.reason.type });
      console.log(`  [Sup:${name}] EXIT from ${workerId}: ${msg.reason.type}`);
    });
});

async function main() {
  console.log("=== Functional Links ===\n");
  const opts = { supervision: { strategy: "Stop" as const, maxRestarts: 0, periodMs: 5000 } };
  const system = createSystem(opts);

  try {
    console.log("--- Demo 1: Crash Propagation ---\n");
    const w1 = system.spawn(Worker, { args: ["W1"] });
    const c1 = system.spawn(Coordinator, { args: ["C1"] });
    c1.cast("linkWorker", "W1", w1);
    await sleep(50);

    console.log("\n  Crashing W1...\n");
    w1.cast("crash");
    await sleep(200);

    const remaining = system.system.getLocalActorIds();
    console.log(`  Remaining actors: ${remaining.length}`);
    console.log("  (Both W1 and C1 crashed due to link)\n");

    console.log("--- Demo 2: Unlink Before Crash ---\n");
    const w2 = system.spawn(Worker, { args: ["W2"] });
    const c2 = system.spawn(Coordinator, { args: ["C2"] });
    c2.cast("linkWorker", "W2", w2);
    await sleep(50);

    c2.cast("unlinkWorker", "W2");
    await sleep(50);

    console.log("\n  Crashing W2 (after unlink)...\n");
    w2.cast("crash");
    await sleep(200);

    const linked = await c2.call("getLinked");
    console.log(`  Coordinator alive! Linked: ${JSON.stringify(linked)}\n`);
    await system.system.stop(c2);

    console.log("--- Demo 3: trapExit ---\n");
    const sup = system.spawn(Supervisor, { args: ["S1"] });
    const w3 = system.spawn(Worker, { args: ["W3"] });
    const w4 = system.spawn(Worker, { args: ["W4"] });

    sup.cast("linkWorker", "W3", w3);
    sup.cast("linkWorker", "W4", w4);
    await sleep(50);

    console.log("\n  Crashing W3...\n");
    w3.cast("crash");
    await sleep(200);

    let workers = await sup.call("getWorkers");
    console.log(`  Supervisor alive! Workers: ${JSON.stringify(workers)}`);

    console.log("\n  Crashing W4...\n");
    w4.cast("crash");
    await sleep(200);

    workers = await sup.call("getWorkers");
    const exitLog = await sup.call("getExitLog");
    console.log(`  Workers: ${JSON.stringify(workers)}`);
    console.log(`  Exit log: ${JSON.stringify(exitLog)}`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
