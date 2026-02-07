// examples/message_stashing.ts
//
// Demonstrates: Message stashing for deferred processing
// Prerequisites: None
// Run: npx ts-node examples/message_stashing.ts
//
// This example shows:
// - Stashing messages when an actor isn't ready to process them
// - unstashAll() to process all stashed messages at once
// - unstash() to process one message at a time
// - clearStash() to discard stashed messages
// - State machine pattern with stashing

import {
  Actor,
  ActorSystem,
  LocalCluster,
  LocalRegistry,
  InMemoryTransport,
} from "../../src";

// --- Database Connection Actor (async initialization) ---

/**
 * Simulates an actor that needs to establish a database connection
 * before it can process queries. Messages are stashed until connected.
 */
class DatabaseActor extends Actor {
  private connected = false;
  private queryCount = 0;

  async init() {
    console.log("[Database] Starting connection...");

    // Simulate async connection (e.g., to a real database)
    await this.simulateConnection();

    this.connected = true;
    console.log("[Database] Connected! Processing stashed queries...");

    // Now process any messages that arrived during connection
    this.unstashAll();
  }

  private async simulateConnection(): Promise<void> {
    // Simulate network latency
    await new Promise(r => setTimeout(r, 200));
  }

  handleCast(message: any): void {
    if (message.type === "query") {
      if (!this.connected) {
        console.log(`[Database] Not connected yet, stashing query: "${message.sql}"`);
        this.stash();
        return;
      }
      this.queryCount++;
      console.log(`[Database] Executing query #${this.queryCount}: "${message.sql}"`);
    }
  }

  handleCall(message: any): any {
    if (message.type === "status") {
      return { connected: this.connected, queryCount: this.queryCount };
    }

    if (message.type === "query") {
      if (!this.connected) {
        console.log(`[Database] Not connected yet, stashing call query: "${message.sql}"`);
        this.stash();
        return; // Will be processed when unstashed
      }
      this.queryCount++;
      console.log(`[Database] Executing call query #${this.queryCount}: "${message.sql}"`);
      return { success: true, rows: this.queryCount };
    }

    return null;
  }
}

// --- Order Processing State Machine ---

type OrderState = "pending" | "processing" | "shipped" | "cancelled";

/**
 * Demonstrates a state machine pattern with stashing.
 * Orders can only be processed when in the right state.
 */
class OrderProcessor extends Actor {
  private state: OrderState = "pending";
  private items: string[] = [];

  init() {
    console.log("[Order] Created in pending state");
  }

  handleCast(message: any): void {
    switch (message.type) {
      case "add_item":
        if (this.state !== "pending") {
          console.log(`[Order] Can't add items in ${this.state} state, stashing`);
          this.stash();
          return;
        }
        this.items.push(message.item);
        console.log(`[Order] Added item: ${message.item} (total: ${this.items.length})`);
        break;

      case "start_processing":
        if (this.state !== "pending") {
          console.log(`[Order] Already ${this.state}, ignoring start_processing`);
          return;
        }
        this.state = "processing";
        console.log(`[Order] Started processing ${this.items.length} items`);
        break;

      case "ship":
        if (this.state !== "processing") {
          console.log(`[Order] Can't ship in ${this.state} state, stashing`);
          this.stash();
          return;
        }
        this.state = "shipped";
        console.log(`[Order] Shipped! Items: ${this.items.join(", ")}`);
        break;

      case "cancel":
        if (this.state === "shipped") {
          console.log("[Order] Can't cancel shipped order");
          return;
        }
        this.state = "cancelled";
        console.log("[Order] Cancelled, clearing stash");
        this.clearStash(); // Discard any stashed messages
        break;

      case "reopen":
        if (this.state !== "cancelled") {
          console.log(`[Order] Can only reopen cancelled orders`);
          return;
        }
        this.state = "pending";
        this.items = [];
        console.log("[Order] Reopened, processing stashed messages");
        this.unstashAll(); // Process any stashed add_item messages
        break;
    }
  }

  handleCall(message: any): any {
    if (message.type === "status") {
      return { state: this.state, items: [...this.items] };
    }
    return null;
  }
}

// --- Rate-Limited Worker (one at a time) ---

/**
 * Demonstrates using unstash() to process one message at a time.
 * Simulates rate-limited API calls.
 */
class RateLimitedWorker extends Actor {
  private busy = false;
  private processed: string[] = [];

  init() {
    console.log("[Worker] Ready (rate-limited: one request at a time)");
  }

  async handleCast(message: any): Promise<void> {
    if (message.type === "request") {
      if (this.busy) {
        console.log(`[Worker] Busy, stashing request: "${message.id}"`);
        this.stash();
        return;
      }

      this.busy = true;
      console.log(`[Worker] Processing request: "${message.id}"`);

      // Simulate API call
      await new Promise(r => setTimeout(r, 100));

      this.processed.push(message.id);
      console.log(`[Worker] Completed: "${message.id}"`);

      this.busy = false;

      // Process next stashed request (one at a time)
      this.unstash();
    }
  }

  handleCall(message: any): any {
    if (message.type === "getProcessed") {
      return [...this.processed];
    }
    return null;
  }
}



// --- Helper ---

async function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  console.log("=== Message Stashing Example ===\n");

  // Setup
  const transport = new InMemoryTransport("node1");
  await transport.connect();
  const registry = new LocalRegistry();
  const cluster = new LocalCluster("node1");
  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClasses([DatabaseActor, OrderProcessor, RateLimitedWorker]);
  await system.start();

  try {
    // === Demo 1: Async Initialization with Stashing ===
    console.log("--- Demo 1: Database Connection (async init) ---\n");

    const db = system.spawn(DatabaseActor);

    // Send queries immediately (before connection is ready)
    db.cast({ type: "query", sql: "SELECT * FROM users" });
    db.cast({ type: "query", sql: "SELECT * FROM orders" });

    // This call will also be stashed and resolved after connection
    const resultPromise = db.call({ type: "query", sql: "SELECT COUNT(*) FROM products" }, 5000);

    db.cast({ type: "query", sql: "INSERT INTO logs VALUES (...)" });

    // Wait for connection and processing
    const result = await resultPromise;
    console.log(`\nCall query result: ${JSON.stringify(result)}`);

    const status = await db.call({ type: "status" });
    console.log(`Final status: ${JSON.stringify(status)}\n`);

    // === Demo 2: State Machine with Stashing ===
    console.log("\n--- Demo 2: Order State Machine ---\n");

    const order = system.spawn(OrderProcessor);

    // Add items while pending (works)
    order.cast({ type: "add_item", item: "Laptop" });
    order.cast({ type: "add_item", item: "Mouse" });
    await delay(50);

    // Try to ship before processing (will be stashed)
    order.cast({ type: "ship" });
    await delay(50);

    // Start processing
    order.cast({ type: "start_processing" });
    await delay(50);

    // Try to add more items (will be stashed - can't add in processing state)
    order.cast({ type: "add_item", item: "Keyboard" });
    await delay(50);

    // Ship the order (now allowed, also processes stashed ship if any)
    order.cast({ type: "ship" });
    await delay(50);

    let orderStatus = await order.call({ type: "status" });
    console.log(`\nOrder status: ${JSON.stringify(orderStatus)}\n`);

    // === Demo 3: Cancel and Clear Stash ===
    console.log("\n--- Demo 3: Cancel Order (clears stash) ---\n");

    const order2 = system.spawn(OrderProcessor);

    order2.cast({ type: "add_item", item: "Book" });
    await delay(50);

    // Start processing
    order2.cast({ type: "start_processing" });
    await delay(50);

    // Try to add items (stashed since we're processing)
    order2.cast({ type: "add_item", item: "Pen" });
    order2.cast({ type: "add_item", item: "Paper" });
    await delay(50);

    // Cancel - this clears the stash
    order2.cast({ type: "cancel" });
    await delay(50);

    // Reopen - stashed add_item messages were discarded
    order2.cast({ type: "reopen" });
    await delay(50);

    const order2Status = await order2.call({ type: "status" });
    console.log(`\nReopened order status: ${JSON.stringify(order2Status)}`);
    console.log("(Pen and Paper were discarded when cancelled)\n");

    // === Demo 4: Rate-Limited Processing ===
    console.log("\n--- Demo 4: Rate-Limited Worker (unstash one at a time) ---\n");

    const worker = system.spawn(RateLimitedWorker);

    // Send multiple requests at once
    worker.cast({ type: "request", id: "req-1" });
    worker.cast({ type: "request", id: "req-2" });
    worker.cast({ type: "request", id: "req-3" });
    worker.cast({ type: "request", id: "req-4" });

    // Wait for all to complete (each takes ~100ms)
    await delay(600);

    const processed = await worker.call({ type: "getProcessed" });
    console.log(`\nProcessed in order: ${JSON.stringify(processed)}`);

  } finally {
    // Cleanup
    await system.shutdown();
    await transport.disconnect();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
