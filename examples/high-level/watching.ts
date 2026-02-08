// examples/high-level/watching.ts
//
// Demonstrates: Actor lifecycle monitoring (watch/unwatch, DOWN messages)
// Run: npx tsx examples/high-level/watching.ts

import { createSystem, createActor, ActorRef, DownMessage, WatchRef } from "../../src";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Worker = createActor((ctx, self, name: string) => {
  console.log(`  [${name}] Started`);

  self
    .call("ping", () => `${name} pong`)
    .onTerminate(() => {
      console.log(`  [${name}] Terminated`);
    });
});

const Monitor = createActor((ctx, self) => {
  const watched = new Map<string, { name: string; watchRef: WatchRef }>();
  const terminationLog: string[] = [];

  console.log("  [Monitor] Started");

  self
    .call("getLog", () => [...terminationLog])
    .call("getWatchCount", () => watched.size)
    .cast("watch", (name: string, ref: ActorRef) => {
      const watchRef = ctx.watch(ref);
      watched.set(ref.id.id, { name, watchRef });
      console.log(`  [Monitor] Now watching: ${name}`);
    })
    .cast("unwatch", (ref: ActorRef) => {
      const entry = watched.get(ref.id.id);
      if (entry) {
        ctx.unwatch(entry.watchRef);
        watched.delete(ref.id.id);
        console.log(`  [Monitor] Unwatched: ${entry.name}`);
      }
    })
    .info("down", (msg: DownMessage) => {
      const entry = watched.get(msg.actorRef.id.id);
      const name = entry?.name || "unknown";
      const reason = msg.reason.type;
      const logEntry = `${name} terminated (${reason})`;
      terminationLog.push(logEntry);
      watched.delete(msg.actorRef.id.id);
      console.log(`  [Monitor] DOWN: ${logEntry}`);
    });
});

const ServiceRegistry = createActor((ctx, self) => {
  const services = new Map<string, ActorRef>();

  console.log("  [Registry] Started");

  self
    .call("list", () => Array.from(services.keys()))
    .cast("register", (name: string, ref: ActorRef) => {
      ctx.watch(ref);
      services.set(name, ref);
      console.log(`  [Registry] Registered: "${name}"`);
    })
    .info("down", (msg: DownMessage) => {
      for (const [name, ref] of services.entries()) {
        if (ref.id.id === msg.actorRef.id.id) {
          services.delete(name);
          console.log(`  [Registry] Auto-removed "${name}" (terminated)`);
          break;
        }
      }
    });
});

async function main() {
  console.log("=== Functional Watching ===\n");
  const system = createSystem();

  try {
    console.log("--- Demo 1: Basic Actor Watching ---\n");
    const monitor = system.spawn(Monitor);
    const w1 = system.spawn(Worker, { args: ["Worker-A"] });
    const w2 = system.spawn(Worker, { args: ["Worker-B"] });
    const w3 = system.spawn(Worker, { args: ["Worker-C"] });
    await sleep(50);

    monitor.cast("watch", "Worker-A", w1);
    monitor.cast("watch", "Worker-B", w2);
    monitor.cast("watch", "Worker-C", w3);
    await sleep(50);

    let watchCount = await monitor.call("getWatchCount");
    console.log(`\n  Watching ${watchCount} actors\n`);

    console.log("  Stopping Worker-A...");
    await system.system.stop(w1);
    await sleep(100);

    console.log("  Stopping Worker-B...");
    await system.system.stop(w2);
    await sleep(100);

    monitor.cast("unwatch", w3);
    await sleep(50);
    console.log("  Stopping Worker-C (unwatched)...");
    await system.system.stop(w3);
    await sleep(100);

    const log = await monitor.call("getLog");
    console.log("\n  Termination log:");
    log.forEach((e: string) => console.log(`    - ${e}`));
    console.log("  (Worker-C not logged — unwatched before stop)\n");

    console.log("--- Demo 2: Service Registry ---\n");
    const registry = system.spawn(ServiceRegistry);
    const svc1 = system.spawn(Worker, { args: ["auth"] });
    const svc2 = system.spawn(Worker, { args: ["database"] });
    const svc3 = system.spawn(Worker, { args: ["cache"] });
    await sleep(50);

    registry.cast("register", "auth", svc1);
    registry.cast("register", "database", svc2);
    registry.cast("register", "cache", svc3);
    await sleep(50);

    let services = await registry.call("list");
    console.log(`  Services: ${JSON.stringify(services)}`);

    console.log("  Stopping database service...");
    await system.system.stop(svc2);
    await sleep(100);

    services = await registry.call("list");
    console.log(`  Services after stop: ${JSON.stringify(services)}`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
