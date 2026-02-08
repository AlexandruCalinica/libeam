// examples/high-level/message_stashing.ts
//
// Demonstrates: Deferred message processing (stash, unstashAll, clearStash)
// Run: npx tsx examples/high-level/message_stashing.ts

import { createSystem, createActor } from "../../src";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Database = createActor((ctx, self) => {
  let connected = false;
  let queryCount = 0;
  console.log("[Database] Starting connection...");
  self
    .call("status", () => ({ connected, queryCount }))
    .cast("query", (sql: string) => {
      if (!connected) {
        console.log(`[Database] Not connected, stashing: "${sql}"`);
        ctx.stash();
        return;
      }
      queryCount++;
      console.log(`[Database] Executing #${queryCount}: "${sql}"`);
    })
    .cast("connect", async () => {
      await delay(200);
      connected = true;
      console.log("[Database] Connected! Replaying stashed...");
      ctx.unstashAll();
    });
});
const OrderProcessor = createActor((ctx, self) => {
  let state: "pending" | "processing" | "shipped" | "cancelled" = "pending";
  const items: string[] = [];
  console.log("[Order] Created in pending state");
  self
    .call("status", () => ({ state, items: [...items] }))
    .cast("add_item", (item: string) => {
      if (state !== "pending") {
        console.log(`[Order] Can't add in ${state} state, stashing`);
        ctx.stash();
        return;
      }
      items.push(item);
      console.log(`[Order] Added: ${item} (total: ${items.length})`);
    })
    .cast("start_processing", () => {
      if (state !== "pending") return;
      state = "processing";
      console.log(`[Order] Processing ${items.length} items`);
    })
    .cast("ship", () => {
      if (state !== "processing") {
        console.log(`[Order] Can't ship in ${state} state, stashing`);
        ctx.stash();
        return;
      }
      state = "shipped";
      console.log(`[Order] Shipped: ${items.join(", ")}`);
    })
    .cast("cancel", () => {
      if (state === "shipped") return;
      state = "cancelled";
      console.log("[Order] Cancelled — clearing stash");
      ctx.clearStash();
    })
    .cast("reopen", () => {
      if (state !== "cancelled") return;
      state = "pending";
      items.length = 0;
      console.log("[Order] Reopened — replaying stashed messages");
      ctx.unstashAll();
    });
});
const RateLimitedWorker = createActor((ctx, self) => {
  let busy = false;
  const processed: string[] = [];
  console.log("[Worker] Ready (one request at a time)");
  self
    .call("getProcessed", () => [...processed])
    .cast("request", async (id: string) => {
      if (busy) {
        console.log(`[Worker] Busy, stashing: "${id}"`);
        ctx.stash();
        return;
      }
      busy = true;
      console.log(`[Worker] Processing: "${id}"`);
      await delay(100);
      processed.push(id);
      console.log(`[Worker] Completed: "${id}"`);
      busy = false;
      ctx.unstash();
    });
});

async function main() {
  console.log("=== Message Stashing Example ===\n");
  const system = createSystem();
  try {
    console.log("--- Demo 1: Database (stash until connected) ---\n");
    const db = system.spawn(Database, {});
    db.cast("query", "SELECT * FROM users");
    db.cast("query", "SELECT * FROM orders");
    db.cast("connect");
    db.cast("query", "INSERT INTO logs VALUES (...)");
    await delay(400);
    console.log(`Status: ${JSON.stringify(await db.call("status"))}\n`);
    console.log("\n--- Demo 2: Order State Machine ---\n");
    const order = system.spawn(OrderProcessor, {});
    order.cast("add_item", "Laptop");
    order.cast("add_item", "Mouse");
    await delay(50);
    order.cast("ship"); // stashed — not in processing yet
    order.cast("start_processing");
    await delay(50);
    order.cast("ship");
    await delay(100);
    console.log(`Order: ${JSON.stringify(await order.call("status"))}\n`);
    console.log("\n--- Demo 3: clearStash on cancel ---\n");
    const o2 = system.spawn(OrderProcessor, {});
    o2.cast("add_item", "Book");
    await delay(50);
    o2.cast("start_processing");
    await delay(50);
    o2.cast("add_item", "Pen");
    o2.cast("add_item", "Paper");
    await delay(50);
    o2.cast("cancel");
    o2.cast("reopen");
    await delay(50);
    console.log(`Reopened: ${JSON.stringify(await o2.call("status"))}`);
    console.log("(Pen and Paper discarded by clearStash)\n");

    console.log("\n--- Demo 4: Rate-Limited Worker ---\n");
    const w = system.spawn(RateLimitedWorker, {});
    w.cast("request", "req-1");
    w.cast("request", "req-2");
    w.cast("request", "req-3");
    w.cast("request", "req-4");
    await delay(600);
    console.log(`\nProcessed: ${JSON.stringify(await w.call("getProcessed"))}`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
