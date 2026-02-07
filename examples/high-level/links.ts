// examples/high-level/links.ts
//
// Demonstrates: Bidirectional crash propagation with links
// Run: npx tsx examples/high-level/links.ts
//
// This example shows:
// - ctx.link() for bidirectional crash propagation
// - ctx.unlink() to remove a link
// - ctx.setTrapExit(true) to receive exit messages instead of crashing
// - self.info("exit", ...) to handle linked actor crashes

import { createSystem, createActor, ActorRef, ExitMessage, LinkRef } from "../../src";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Worker: can crash on command ---

const Worker = createActor((ctx, self, name: string) => {
  let workDone = 0;
  console.log(`  [${name}] Started`);

  self
    .call("getWork", () => workDone)
    .cast("work", () => {
      workDone++;
      console.log(`  [${name}] Did work #${workDone}`);
    })
    .cast("crash", () => {
      console.log(`  [${name}] Crashing!`);
      throw new Error(`${name} crashed`);
    })
    .onTerminate(() => {
      console.log(`  [${name}] Terminated`);
    });
});

// --- Coordinator: links to workers (no trapExit) ---

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

// --- Supervisor: links with trapExit enabled ---

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

// --- Main ---

async function main() {
  console.log("=== Functional Links ===\n");
  const system = createSystem({ supervision: { strategy: "Stop", maxRestarts: 0, periodMs: 5000 } });

  try {
    // Demo 1: Basic link — crash propagates
    console.log("--- Demo 1: Crash Propagation ---\n");

    const w1 = system.spawn(Worker, { args: ["W1"] });
    const c1 = system.spawn(Coordinator, { args: ["C1"] });
    c1.cast({ method: "linkWorker", args: ["W1", w1] });
    await sleep(50);

    console.log("\n  Crashing W1...\n");
    w1.cast({ method: "crash", args: [] });
    await sleep(200);

    const remaining = system.system.getLocalActorIds();
    console.log(`  Remaining actors: ${remaining.length}`);
    console.log("  (Both W1 and C1 crashed due to link)\n");

    // Demo 2: Unlink before crash — coordinator survives
    console.log("--- Demo 2: Unlink Before Crash ---\n");

    const w2 = system.spawn(Worker, { args: ["W2"] });
    const c2 = system.spawn(Coordinator, { args: ["C2"] });
    c2.cast({ method: "linkWorker", args: ["W2", w2] });
    await sleep(50);

    c2.cast({ method: "unlinkWorker", args: ["W2"] });
    await sleep(50);

    console.log("\n  Crashing W2 (after unlink)...\n");
    w2.cast({ method: "crash", args: [] });
    await sleep(200);

    const linked = await c2.call({ method: "getLinked", args: [] });
    console.log(`  Coordinator alive! Linked: ${JSON.stringify(linked)}\n`);
    await system.system.stop(c2);

    // Demo 3: trapExit — supervisor handles crashes
    console.log("--- Demo 3: trapExit ---\n");

    const sup = system.spawn(Supervisor, { args: ["S1"] });
    const w3 = system.spawn(Worker, { args: ["W3"] });
    const w4 = system.spawn(Worker, { args: ["W4"] });

    sup.cast({ method: "linkWorker", args: ["W3", w3] });
    sup.cast({ method: "linkWorker", args: ["W4", w4] });
    await sleep(50);

    console.log("\n  Crashing W3...\n");
    w3.cast({ method: "crash", args: [] });
    await sleep(200);

    let workers = await sup.call({ method: "getWorkers", args: [] });
    console.log(`  Supervisor alive! Workers: ${JSON.stringify(workers)}`);

    console.log("\n  Crashing W4...\n");
    w4.cast({ method: "crash", args: [] });
    await sleep(200);

    workers = await sup.call({ method: "getWorkers", args: [] });
    const exitLog = await sup.call({ method: "getExitLog", args: [] });
    console.log(`  Workers: ${JSON.stringify(workers)}`);
    console.log(`  Exit log: ${JSON.stringify(exitLog)}`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
