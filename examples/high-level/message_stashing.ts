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
    .call("query", (sql: string) => {
      if (!connected) {
        console.log(`[Database] Not connected, stashing call: "${sql}"`);
        ctx.stash();
        return;
      }
      queryCount++;
      console.log(`[Database] Query #${queryCount}: "${sql}"`);
      return { success: true, rows: queryCount };
    })
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
      console.log("[Database] Connected! Replaying stashed queries...");
      ctx.unstashAll();
    });
});

type OrderState = "pending" | "processing" | "shipped" | "cancelled";

const OrderProcessor = createActor((ctx, self) => {
  let state: OrderState = "pending";
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
      if (state === "shipped") {
        console.log("[Order] Can't cancel shipped order");
        return;
      }
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
    console.log("--- Demo 1: Database (async init with stashing) ---\n");
    const db = system.spawn(Database, {});
    db.cast({ method: "query", args: ["SELECT * FROM users"] });
    db.cast({ method: "query", args: ["SELECT * FROM orders"] });
    const resultPromise = db.call({ method: "query", args: ["SELECT COUNT(*) FROM products"] }, 5000);
    db.cast({ method: "connect", args: [] });
    const result = await resultPromise;
    console.log(`\nCall result: ${JSON.stringify(result)}`);
    await delay(100);
    const status = await db.call({ method: "status", args: [] });
    console.log(`Status: ${JSON.stringify(status)}\n`);

    console.log("\n--- Demo 2: Order State Machine ---\n");
    const order = system.spawn(OrderProcessor, {});
    order.cast({ method: "add_item", args: ["Laptop"] });
    order.cast({ method: "add_item", args: ["Mouse"] });
    await delay(50);
    order.cast({ method: "ship", args: [] });
    await delay(50);
    order.cast({ method: "start_processing", args: [] });
    await delay(50);
    order.cast({ method: "ship", args: [] });
    await delay(50);
    const orderStatus = await order.call({ method: "status", args: [] });
    console.log(`\nOrder: ${JSON.stringify(orderStatus)}\n`);

    console.log("\n--- Demo 3: Cancel (clears stash) ---\n");
    const order2 = system.spawn(OrderProcessor, {});
    order2.cast({ method: "add_item", args: ["Book"] });
    await delay(50);
    order2.cast({ method: "start_processing", args: [] });
    await delay(50);
    order2.cast({ method: "add_item", args: ["Pen"] });
    order2.cast({ method: "add_item", args: ["Paper"] });
    await delay(50);
    order2.cast({ method: "cancel", args: [] });
    await delay(50);
    order2.cast({ method: "reopen", args: [] });
    await delay(50);
    const order2Status = await order2.call({ method: "status", args: [] });
    console.log(`\nReopened: ${JSON.stringify(order2Status)}`);
    console.log("(Pen and Paper were discarded on cancel)\n");

    console.log("\n--- Demo 4: Rate-Limited Worker ---\n");
    const worker = system.spawn(RateLimitedWorker, {});
    worker.cast({ method: "request", args: ["req-1"] });
    worker.cast({ method: "request", args: ["req-2"] });
    worker.cast({ method: "request", args: ["req-3"] });
    worker.cast({ method: "request", args: ["req-4"] });
    await delay(600);
    const processed = await worker.call({ method: "getProcessed", args: [] });
    console.log(`\nProcessed in order: ${JSON.stringify(processed)}`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
