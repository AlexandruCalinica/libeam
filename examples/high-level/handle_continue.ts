// examples/high-level/handle_continue.ts
//
// Demonstrates: Async post-init with onContinue and return { continue: data }
// Run: npx tsx examples/high-level/handle_continue.ts

import { createSystem, createActor } from "../../src";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchUser(id: string) {
  await delay(100);
  return { id, name: "John Doe", email: "john@example.com" };
}

async function fetchConfig() {
  await delay(80);
  return { theme: "dark", language: "en", maxRetries: 3 };
}

const UserSession = createActor((ctx, self, userId: string) => {
  let user: any = null;
  let ready = false;

  console.log(`[Session:${userId}] init() — quick setup done`);

  self
    .onContinue(async (data: { userId: string }) => {
      console.log(`[Session:${data.userId}] onContinue() — loading user data...`);
      user = await fetchUser(data.userId);
      ready = true;
      console.log(`[Session:${data.userId}] onContinue() — ready! User: ${user.name}`);
    })
    .call("isReady", () => ready)
    .call("getUser", () => user)
    .onTerminate(() => console.log(`[Session:${userId}] Terminated`));

  return { continue: { userId } } as any;
});

const ConfigManager = createActor((ctx, self) => {
  let config: any = { version: "1.0.0" };
  let sources: string[] = [];

  console.log("[ConfigManager] init() — registering sources");

  self
    .onContinue(async (data: { sources: string[] }) => {
      console.log(`[ConfigManager] onContinue() — loading ${data.sources.length} sources...`);
      const [dbConfig, remoteConfig] = await Promise.all([
        delay(60).then(() => ({ dbHost: "localhost", dbPort: 5432 })),
        fetchConfig(),
      ]);
      config = { ...config, ...dbConfig, ...remoteConfig };
      sources = data.sources;
      console.log("[ConfigManager] onContinue() — all configs loaded!");
    })
    .call("getConfig", () => config)
    .call("getSources", () => sources)
    .onTerminate(() => console.log("[ConfigManager] Terminated"));

  return { continue: { sources: ["database", "remote", "environment"] } } as any;
});

const Service = createActor((ctx, self) => {
  const connections: string[] = [];
  let status = "initializing";

  console.log("[Service] init() — preparing to connect");

  self
    .onContinue(async (data: { endpoints: string[] }) => {
      console.log(`[Service] onContinue() — connecting to ${data.endpoints.length} endpoints...`);
      for (const ep of data.endpoints) {
        await delay(50);
        connections.push(ep);
        console.log(`[Service] Connected to ${ep}`);
      }
      status = "ready";
      console.log("[Service] onContinue() — all connections established!");
    })
    .call("getStatus", () => status)
    .call("getConnections", () => [...connections])
    .onTerminate(() => console.log("[Service] Terminated"));

  return { continue: { endpoints: ["api.example.com", "db.example.com", "cache.example.com"] } } as any;
});

async function main() {
  console.log("=== handleContinue Example ===\n");
  console.log("onContinue runs expensive async init without blocking spawn().\n");
  const system = createSystem();

  try {
    console.log("--- Demo 1: User Session (async data loading) ---\n");
    const session = system.spawn(UserSession, { args: ["user-123"] });
    console.log("spawn() returned immediately!\n");
    let ready = await session.call({ method: "isReady", args: [] });
    console.log(`Ready immediately: ${ready}`);
    await delay(150);
    ready = await session.call({ method: "isReady", args: [] });
    console.log(`Ready after 150ms: ${ready}`);
    const user = await session.call({ method: "getUser", args: [] });
    console.log(`User: ${JSON.stringify(user)}\n`);

    console.log("\n--- Demo 2: Config Manager (parallel loading) ---\n");
    const cfgMgr = system.spawn(ConfigManager, {});
    console.log("spawn() returned immediately!\n");
    await delay(150);
    const config = await cfgMgr.call({ method: "getConfig", args: [] });
    console.log(`Config: ${JSON.stringify(config)}`);
    const srcs = await cfgMgr.call({ method: "getSources", args: [] });
    console.log(`Sources: ${JSON.stringify(srcs)}\n`);

    console.log("\n--- Demo 3: Service (sequential connections) ---\n");
    const svc = system.spawn(Service, {});
    console.log("spawn() returned immediately!\n");
    let status = await svc.call({ method: "getStatus", args: [] });
    console.log(`Status immediately: ${status}`);
    await delay(250);
    status = await svc.call({ method: "getStatus", args: [] });
    const conns = await svc.call({ method: "getConnections", args: [] });
    console.log(`Status after 250ms: ${status}`);
    console.log(`Connections: ${JSON.stringify(conns)}\n`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
