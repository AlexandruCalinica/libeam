// examples/high-level/distributed.ts
//
// Demonstrates: Distributed actors across two nodes with the functional API
// Prerequisites: Two terminals
// Run:
//   Terminal 1: npx tsx examples/high-level/distributed.ts node1
//   Terminal 2: npx tsx examples/high-level/distributed.ts node2
//
// This example shows:
// - createSystem({ type: "distributed" }) for zero-boilerplate multi-node setup
// - Cookie-based authentication: both nodes must share the same cookie to communicate
// - Named actors for cross-node discovery via ctx.getActorByName()
// - ActorRegistry module augmentation for typed getActorByName
// - Bidirectional ping-pong between actors on different nodes

import { createSystem, createActor, type ActorRegistry } from "../../src";

// --- Actor Definitions ---

const Ping = createActor((ctx, self) => {
  let count = 0;

  return self
    .onCall("getCount", () => count)
    .onCast("start", async () => {
      const pong = await ctx.getActorByName("pong");
      if (pong) {
        console.log("[node1] Found pong actor, starting game!");
        pong.cast("ping", 0);
      } else {
        console.log("[node1] Pong actor not found, retrying in 1s...");
        setTimeout(() => ctx.self.cast({ method: "start", args: [] }), 1000);
      }
    })
    .onCast("pong", async (n: number) => {
      count = n;
      console.log(`[node1] Received pong #${count}`);

      if (count < 5) {
        const pong = await ctx.getActorByName("pong");
        if (pong) {
          setTimeout(() => pong.cast("ping", count + 1), 500);
        }
      } else {
        console.log("[node1] Game complete!");
        process.exit(0);
      }
    });
});

const Pong = createActor((ctx, self) => {
  let count = 0;

  return self
    .onCall("getCount", () => count)
    .onCast("ping", async (n: number) => {
      count = n;
      console.log(`[node2] Received ping #${count}, sending pong...`);

      const ping = await ctx.getActorByName("ping");
      if (ping) {
        setTimeout(() => ping.cast("pong", count), 500);
      } else {
        console.log("[node2] Could not find ping actor to respond!");
      }
    });
});

declare module "../../src" {
  interface ActorRegistry {
    ping: typeof Ping;
    pong: typeof Pong;
  }
}

// --- Main ---

async function main() {
  const nodeArg = process.argv[2];

  if (nodeArg === "node1") {
    console.log("=== Starting Node 1 (Ping) ===\n");

    const system = await createSystem({
      type: "distributed",
      nodeId: "node1",
      port: 5000,
      seedNodes: ["127.0.0.1:5012"],
      cookie: "my-cluster-secret",
    });

    const ping = system.spawn(Ping, { name: "ping" });
    console.log("[node1] Ping actor spawned, waiting for pong...\n");

    setTimeout(() => {
      ping.cast("start");
    }, 3000);

    process.on("SIGINT", async () => {
      console.log("\n[node1] Shutting down...");
      await system.shutdown();
      process.exit(0);
    });
  } else if (nodeArg === "node2") {
    console.log("=== Starting Node 2 (Pong) ===\n");

    const system = await createSystem({
      type: "distributed",
      nodeId: "node2",
      port: 5010,
      seedNodes: ["127.0.0.1:5002"],
      cookie: "my-cluster-secret",
    });

    system.spawn(Pong, { name: "pong" });
    console.log("[node2] Pong actor spawned, waiting for pings...\n");

    process.on("SIGINT", async () => {
      console.log("\n[node2] Shutting down...");
      await system.shutdown();
      process.exit(0);
    });
  } else {
    console.log("Usage: npx tsx examples/high-level/distributed.ts <node1|node2>");
    console.log("");
    console.log("Run in two separate terminals:");
    console.log("  Terminal 1: npx tsx examples/high-level/distributed.ts node1");
    console.log("  Terminal 2: npx tsx examples/high-level/distributed.ts node2");
    console.log("");
    console.log("Demonstrates distributed actors communicating via createSystem()");
    console.log("with automatic ZeroMQ transport and gossip-based cluster membership.");
    process.exit(1);
  }
}

main().catch(console.error);
