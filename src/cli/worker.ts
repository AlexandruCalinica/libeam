import type { SupervisorMessage, WorkerMessage } from "./ipc.js";

async function main() {
  const entry = process.env.LIBEAM_ENTRY;
  const port = parseInt(process.env.LIBEAM_PORT ?? "0", 10);
  const cookie = process.env.LIBEAM_COOKIE || undefined;
  const seedNodes = process.env.LIBEAM_SEED_NODES?.split(",").filter(Boolean) ?? [];
  const roles = process.env.LIBEAM_ROLES?.split(",").filter(Boolean) ?? [];
  const name = process.env.LIBEAM_NODE_NAME ?? "unknown";

  if (!entry) {
    send({ type: "error", message: "No LIBEAM_ENTRY specified" });
    process.exit(1);
  }

  try {
    // Dynamically import the entry module
    const mod = await import(entry);
    const startFn = mod.default;

    if (typeof startFn !== "function") {
      send({ type: "error", message: `Entry module "${entry}" must export a default function` });
      process.exit(1);
    }

    // Call the entry function — it should return a system (or object with system)
    const result = await startFn({ port, cookie, seedNodes, roles, name });

    // Extract the system — entry can return system directly or { system }
    const system = result?.system ?? result;

    if (!system || typeof system.shutdown !== "function") {
      send({ type: "error", message: "Entry function must return an ActorSystem or { system: ActorSystem }" });
      process.exit(1);
    }

    const nodeId = system.id ?? name;
    send({ type: "ready", nodeId, port, roles });

    const startTime = Date.now();

    // Handle supervisor messages
    process.on("message", async (msg: SupervisorMessage) => {
      try {
        switch (msg.type) {
          case "health": {
            const health = system.getHealth();
            send({ type: "health", status: health.status, details: health.details });
            break;
          }
          case "actors": {
            const actors = typeof system.getActors === "function" ? system.getActors() : [];
            send({ type: "actors", actors });
            break;
          }
          case "status": {
            const health = system.getHealth();
            send({
              type: "status",
              data: {
                nodeId,
                port,
                roles,
                actorCount: health.details?.actorCount ?? 0,
                health: health.status,
                uptime: Date.now() - startTime,
              },
            });
            break;
          }
          case "drain": {
            const drainResult = await system.drain({
              migrateTarget: msg.target,
              timeout: msg.timeout ?? 30000,
            });
            send({
              type: "drain_complete",
              migrated: drainResult.migrated,
              drained: drainResult.drained,
              failed: drainResult.failed,
            });
            break;
          }
          case "stop": {
            await system.shutdown({ timeout: msg.timeout ?? 5000, drainMailboxes: true });
            send({ type: "stopped" });
            process.exit(0);
          }
        }
      } catch (err: unknown) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });

    // Handle process signals
    process.on("SIGTERM", async () => {
      await system.shutdown({ timeout: 5000, drainMailboxes: true });
      process.exit(0);
    });
  } catch (err: unknown) {
    send({ type: "error", message: `Failed to start: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }
}

function send(msg: WorkerMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

main();
