// examples/high-level/idle_timeout.ts
//
// Demonstrates: Idle timeout patterns (setIdleTimeout, info "timeout")
// Run: npx tsx examples/high-level/idle_timeout.ts

import { createSystem, createActor } from "../../src";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Cache = createActor((ctx, self) => {
  const data = new Map<string, string>();
  let timeoutCount = 0;
  console.log("[Cache] Started — will clear after 150ms idle");
  self.setIdleTimeout(150);
  return self
    .onInfo("timeout", () => {
      timeoutCount++;
      console.log(`[Cache] IDLE TIMEOUT — clearing ${data.size} entries`);
      data.clear();
    })
    .onCall("size", () => data.size)
    .onCall("timeoutCount", () => timeoutCount)
    .onCast("set", (key: string, value: string) => {
      data.set(key, value);
      console.log(`[Cache] Set "${key}" = "${value}" (size: ${data.size})`);
    });
});

const Session = createActor((ctx, self, userId: string) => {
  let state: "active" | "warning" | "expired" = "active";
  console.log(`[Session:${userId}] Started — active`);
  self.setIdleTimeout(150);
  return self
    .onInfo("timeout", () => {
      if (state === "active") {
        state = "warning";
        console.log(`[Session:${userId}] WARNING: idle — will expire in 100ms`);
        self.setIdleTimeout(100);
      } else if (state === "warning") {
        state = "expired";
        console.log(`[Session:${userId}] EXPIRED`);
        self.setIdleTimeout(0);
      }
    })
    .onCall("state", () => state)
    .onCast("activity", (action: string) => {
      console.log(`[Session:${userId}] Activity: ${action}`);
      if (state === "warning") {
        console.log(`[Session:${userId}] Back to active`);
        state = "active";
        self.setIdleTimeout(150);
      }
    });
});

const ConnectionPool = createActor((ctx, self) => {
  const connections = new Map<string, { lastUsed: number; active: boolean }>();
  let nextId = 1;
  let pruneCount = 0;
  console.log("[Pool] Started — prunes idle connections every 150ms");
  self.setIdleTimeout(150);
  return self
    .onInfo("timeout", () => {
      const now = Date.now();
      const toPrune: string[] = [];
      for (const [id, conn] of connections.entries()) {
        if (!conn.active && now - conn.lastUsed > 100) toPrune.push(id);
      }
      if (toPrune.length > 0) {
        for (const id of toPrune) connections.delete(id);
        pruneCount += toPrune.length;
        console.log(`[Pool] Pruned ${toPrune.length} idle: ${toPrune.join(", ")}`);
      } else {
        console.log("[Pool] Prune check: no idle connections");
      }
    })
    .onCall("count", () => connections.size)
    .onCall("pruned", () => pruneCount)
    .onCall("list", () => Array.from(connections.keys()))
    .onCast("acquire", () => {
      const id = `conn-${nextId++}`;
      connections.set(id, { lastUsed: Date.now(), active: true });
      console.log(`[Pool] Acquired ${id} (total: ${connections.size})`);
    })
    .onCast("release", (connId: string) => {
      const conn = connections.get(connId);
      if (conn) {
        conn.active = false;
        conn.lastUsed = Date.now();
        console.log(`[Pool] Released ${connId}`);
      }
    });
});

async function main() {
  console.log("=== Idle Timeout Example ===\n");
  const system = createSystem();

  try {
    console.log("--- Demo 1: Cache (idle cleanup) ---\n");
    const cache = system.spawn(Cache, {});
    cache.cast("set", "user:1", "Alice");
    cache.cast("set", "user:2", "Bob");
    await delay(50);
    console.log(`Cache size: ${await cache.call("size")}`);
    console.log("\nWaiting for idle timeout...\n");
    await delay(300);
    console.log(`Cache size after timeout: ${await cache.call("size")}`);
    console.log(`Timeout count: ${await cache.call("timeoutCount")}\n`);

    console.log("\n--- Demo 2: Session (warning then expire) ---\n");
    const session = system.spawn(Session, { args: ["user-123"] });
    session.cast("activity", "login");
    await delay(50);
    session.cast("activity", "view_page");
    await delay(50);
    console.log(`State: ${await session.call("state")}`);
    console.log("\nWaiting for warning...\n");
    await delay(160);
    console.log(`State: ${await session.call("state")}`);
    session.cast("activity", "click_button");
    await delay(50);
    console.log(`State after activity: ${await session.call("state")}`);
    console.log("\nWaiting for expiration...\n");
    await delay(300);
    console.log(`Final state: ${await session.call("state")}\n`);

    console.log("\n--- Demo 3: Connection Pool (periodic pruning) ---\n");
    const pool = system.spawn(ConnectionPool, {});
    pool.cast("acquire");
    pool.cast("acquire");
    pool.cast("acquire");
    await delay(50);
    pool.cast("release", "conn-1");
    pool.cast("release", "conn-2");
    await delay(50);
    console.log(`Connections: ${await pool.call("count")}`);
    console.log("\nWaiting for prune cycle...\n");
    await delay(250);
    console.log(`After prune: ${await pool.call("count")}`);
    console.log(`Pruned: ${await pool.call("pruned")}`);
    console.log(`Remaining: ${JSON.stringify(await pool.call("list"))}\n`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
