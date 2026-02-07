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
  self
    .info("timeout", () => {
      timeoutCount++;
      console.log(`[Cache] IDLE TIMEOUT — clearing ${data.size} entries`);
      data.clear();
    })
    .call("size", () => data.size)
    .call("timeoutCount", () => timeoutCount)
    .cast("set", (key: string, value: string) => {
      data.set(key, value);
      console.log(`[Cache] Set "${key}" = "${value}" (size: ${data.size})`);
    });
});

const Session = createActor((ctx, self, userId: string) => {
  let state: "active" | "warning" | "expired" = "active";
  console.log(`[Session:${userId}] Started — active`);
  self.setIdleTimeout(150);
  self
    .info("timeout", () => {
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
    .call("state", () => state)
    .cast("activity", (action: string) => {
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
  self
    .info("timeout", () => {
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
    .call("count", () => connections.size)
    .call("pruned", () => pruneCount)
    .call("list", () => Array.from(connections.keys()))
    .cast("acquire", () => {
      const id = `conn-${nextId++}`;
      connections.set(id, { lastUsed: Date.now(), active: true });
      console.log(`[Pool] Acquired ${id} (total: ${connections.size})`);
    })
    .cast("release", (connId: string) => {
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
    cache.cast({ method: "set", args: ["user:1", "Alice"] });
    cache.cast({ method: "set", args: ["user:2", "Bob"] });
    await delay(50);
    console.log(`Cache size: ${await cache.call({ method: "size", args: [] })}`);
    console.log("\nWaiting for idle timeout...\n");
    await delay(300);
    console.log(`Cache size after timeout: ${await cache.call({ method: "size", args: [] })}`);
    console.log(`Timeout count: ${await cache.call({ method: "timeoutCount", args: [] })}\n`);

    console.log("\n--- Demo 2: Session (warning then expire) ---\n");
    const session = system.spawn(Session, { args: ["user-123"] });
    session.cast({ method: "activity", args: ["login"] });
    await delay(50);
    session.cast({ method: "activity", args: ["view_page"] });
    await delay(50);
    console.log(`State: ${await session.call({ method: "state", args: [] })}`);
    console.log("\nWaiting for warning...\n");
    await delay(160);
    console.log(`State: ${await session.call({ method: "state", args: [] })}`);
    session.cast({ method: "activity", args: ["click_button"] });
    await delay(50);
    console.log(`State after activity: ${await session.call({ method: "state", args: [] })}`);
    console.log("\nWaiting for expiration...\n");
    await delay(300);
    console.log(`Final state: ${await session.call({ method: "state", args: [] })}\n`);

    console.log("\n--- Demo 3: Connection Pool (periodic pruning) ---\n");
    const pool = system.spawn(ConnectionPool, {});
    pool.cast({ method: "acquire", args: [] });
    pool.cast({ method: "acquire", args: [] });
    pool.cast({ method: "acquire", args: [] });
    await delay(50);
    pool.cast({ method: "release", args: ["conn-1"] });
    pool.cast({ method: "release", args: ["conn-2"] });
    console.log(`\nConnections: ${await pool.call({ method: "count", args: [] })}`);
    console.log("\nWaiting for prune cycle...\n");
    await delay(200);
    console.log(`After prune: ${await pool.call({ method: "count", args: [] })}`);
    console.log(`Pruned: ${await pool.call({ method: "pruned", args: [] })}`);
    console.log(`Remaining: ${JSON.stringify(await pool.call({ method: "list", args: [] }))}\n`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
