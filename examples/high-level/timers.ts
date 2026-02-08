// examples/high-level/timers.ts
//
// Demonstrates: Timer patterns (heartbeat, reminders, debounce, timeouts)
// Run: npx tsx examples/high-level/timers.ts

import { createSystem, createActor } from "../../src";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const methodMsg = (method: string, ...args: any[]) => ({ method, args });

const Heartbeat = createActor((ctx, self) => {
  let count = 0;
  let stopped = false;
  self.sendInterval(methodMsg("beat"), 200);

  self
    .call("getCount", () => count)
    .cast("beat", () => {
      if (stopped) return;
      count++;
      console.log(`  [Heartbeat] Beat #${count}`);
    })
    .cast("stop", () => {
      stopped = true;
      console.log("  [Heartbeat] Stopped");
    });
});

const Reminder = createActor((ctx, self) => {
  const fired: string[] = [];

  self
    .call("getFired", () => [...fired])
    .cast("schedule", (text: string, delayMs: number) => {
      console.log(`  [Reminder] Scheduling "${text}" in ${delayMs}ms`);
      self.sendAfter(methodMsg("fire", text), delayMs);
    })
    .cast("fire", (text: string) => {
      console.log(`  [Reminder] FIRED: ${text}`);
      fired.push(text);
    });
});

const Debounce = createActor((ctx, self) => {
  const processed: string[] = [];
  let generation = 0;

  self
    .call("getProcessed", () => [...processed])
    .cast("input", (value: string) => {
      generation++;
      const myGen = generation;
      console.log(`  [Debounce] Input: "${value}" (gen=${myGen})`);
      self.sendAfter(methodMsg("process", value, myGen), 300);
    })
    .cast("process", (value: string, gen: number) => {
      if (gen !== generation) return;
      console.log(`  [Debounce] Processing: "${value}"`);
      processed.push(value);
    });
});

const TimeoutTracker = createActor((ctx, self) => {
  let nextId = 0;
  const pending = new Set<string>();

  self
    .call("getPendingCount", () => pending.size)
    .call("startRequest", (timeoutMs: number) => {
      const id = `req-${++nextId}`;
      pending.add(id);
      console.log(`  [Timeout] Started ${id} (timeout=${timeoutMs}ms)`);
      self.sendAfter(methodMsg("expire", id), timeoutMs);
      return id;
    })
    .cast("complete", (id: string) => {
      if (pending.delete(id)) console.log(`  [Timeout] ${id} completed in time`);
    })
    .cast("expire", (id: string) => {
      if (pending.delete(id)) console.log(`  [Timeout] ${id} TIMED OUT`);
    });
});

async function main() {
  console.log("=== Functional Timers ===\n");
  const system = createSystem();

  try {
    console.log("--- Heartbeat (sendInterval) ---\n");
    const hb = system.spawn(Heartbeat);
    await sleep(550);
    hb.cast("stop");
    await sleep(50);
    const beats = await hb.call("getCount");
    console.log(`  Total beats: ${beats}\n`);

    console.log("--- Reminders (sendAfter) ---\n");
    const rem = system.spawn(Reminder);
    rem.cast("schedule", "Take a break", 100);
    rem.cast("schedule", "Check email", 200);
    rem.cast("schedule", "Lunch time", 300);
    await sleep(400);
    const fired = await rem.call("getFired");
    console.log(`  All fired: ${JSON.stringify(fired)}\n`);

    console.log("--- Debounce (generation-based) ---\n");
    const deb = system.spawn(Debounce);
    deb.cast("input", "a");
    await sleep(100);
    deb.cast("input", "ab");
    await sleep(100);
    deb.cast("input", "abc");
    await sleep(400);
    const debProcessed = await deb.call("getProcessed");
    console.log(`  Processed: ${JSON.stringify(debProcessed)}`);
    console.log("  (Only 'abc' — earlier inputs were superseded)\n");

    console.log("--- Request Timeouts ---\n");
    const tt = system.spawn(TimeoutTracker);
    const r1 = await tt.call("startRequest", 200);
    const r2 = await tt.call("startRequest", 500);
    await sleep(100);
    tt.cast("complete", r2);
    await sleep(200);
    const pending = await tt.call("getPendingCount");
    console.log(`  Pending: ${pending}\n`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
