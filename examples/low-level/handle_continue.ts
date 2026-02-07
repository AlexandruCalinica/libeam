// examples/handle_continue.ts
//
// Demonstrates: handleContinue for async post-initialization work
// Prerequisites: None
// Run: npx ts-node examples/handle_continue.ts

import {
  Actor,
  ActorSystem,
  LocalCluster,
  InMemoryTransport,
  LocalRegistry,
  InitContinue,
} from "../../src";



// --- Simulated External Services ---

async function fetchUserFromDatabase(userId: string): Promise<any> {
  // Simulate database fetch
  await sleep(100);
  return { id: userId, name: "John Doe", email: "john@example.com" };
}

async function fetchConfigFromRemote(): Promise<any> {
  // Simulate remote config fetch
  await sleep(150);
  return { theme: "dark", language: "en", maxRetries: 3 };
}

async function warmupCache(keys: string[]): Promise<void> {
  // Simulate cache warmup
  await sleep(200);
  console.log(`[Cache] Warmed up ${keys.length} keys`);
}

// --- Actor Definitions ---

/**
 * A user session actor that loads user data asynchronously after init.
 *
 * init() returns quickly, signaling that expensive async work
 * should happen in handleContinue(). This allows spawn() to return
 * immediately while the actor continues loading in the background.
 */
class UserSessionActor extends Actor {
  private userId!: string;
  private user: any = null;
  private ready = false;

  init(userId: string): InitContinue<{ userId: string }> {
    this.userId = userId;
    console.log(`[Session:${userId}] init() - quick setup done`);

    // Return continue signal to trigger async work
    return { continue: { userId } };
  }

  async handleContinue(data: { userId: string }): Promise<void> {
    console.log(`[Session:${data.userId}] handleContinue() - loading user data...`);

    // Perform expensive async initialization
    this.user = await fetchUserFromDatabase(data.userId);
    this.ready = true;

    console.log(`[Session:${data.userId}] handleContinue() - ready! User: ${this.user.name}`);
  }

  handleCall(message: any) {
    if (message.type === "getUser") {
      return this.user;
    } else if (message.type === "isReady") {
      return this.ready;
    }
    return null;
  }

  terminate() {
    console.log(`[Session:${this.userId}] Terminated`);
  }
}

/**
 * A configuration manager that loads multiple configs in parallel.
 * Demonstrates complex async initialization with multiple data sources.
 */
class ConfigManagerActor extends Actor {
  private config: any = {};
  private loadedSources: string[] = [];

  init(): InitContinue<{ sources: string[] }> {
    console.log("[ConfigManager] init() - registering config sources");

    // Quick sync setup
    this.config = { version: "1.0.0" };

    // Signal async work needed
    return { continue: { sources: ["database", "remote", "environment"] } };
  }

  async handleContinue(data: { sources: string[] }): Promise<void> {
    console.log(`[ConfigManager] handleContinue() - loading ${data.sources.length} sources...`);

    // Load configs from multiple sources in parallel
    const [dbConfig, remoteConfig] = await Promise.all([
      this.loadDatabaseConfig(),
      fetchConfigFromRemote(),
    ]);

    // Merge configurations
    this.config = {
      ...this.config,
      ...dbConfig,
      ...remoteConfig,
      env: process.env.NODE_ENV || "development",
    };

    this.loadedSources = data.sources;
    console.log("[ConfigManager] handleContinue() - all configs loaded!");
  }

  private async loadDatabaseConfig(): Promise<any> {
    await sleep(80);
    return { dbHost: "localhost", dbPort: 5432 };
  }

  handleCall(message: any) {
    if (message.type === "getConfig") {
      return this.config;
    } else if (message.type === "getSources") {
      return this.loadedSources;
    }
    return null;
  }

  terminate() {
    console.log("[ConfigManager] Terminated");
  }
}

/**
 * A cache actor that pre-warms itself with frequently accessed data.
 * Shows init returning without continue vs with continue.
 */
class CacheActor extends Actor {
  private cache = new Map<string, any>();
  private warmupComplete = false;

  init(warmupKeys?: string[]): void | InitContinue<{ keys: string[] }> {
    console.log("[Cache] init() - creating cache");

    if (warmupKeys && warmupKeys.length > 0) {
      // Need to warm up - return continue signal
      console.log(`[Cache] init() - warmup requested for ${warmupKeys.length} keys`);
      return { continue: { keys: warmupKeys } };
    }

    // No warmup needed - init is complete
    console.log("[Cache] init() - no warmup needed, ready immediately");
    this.warmupComplete = true;
  }

  async handleContinue(data: { keys: string[] }): Promise<void> {
    console.log(`[Cache] handleContinue() - warming up cache...`);

    await warmupCache(data.keys);

    // Populate cache with mock data
    for (const key of data.keys) {
      this.cache.set(key, { key, value: `cached_${key}`, timestamp: Date.now() });
    }

    this.warmupComplete = true;
    console.log(`[Cache] handleContinue() - warmup complete, ${this.cache.size} entries cached`);
  }

  handleCast(message: any) {
    if (message.type === "set") {
      this.cache.set(message.key, message.value);
    } else if (message.type === "delete") {
      this.cache.delete(message.key);
    }
  }

  handleCall(message: any) {
    if (message.type === "get") {
      return this.cache.get(message.key);
    } else if (message.type === "isWarmedUp") {
      return this.warmupComplete;
    } else if (message.type === "size") {
      return this.cache.size;
    }
    return null;
  }

  terminate() {
    console.log("[Cache] Terminated");
  }
}

/**
 * A service actor that connects to external dependencies.
 * Demonstrates error handling in handleContinue.
 */
class ServiceActor extends Actor {
  private connections: string[] = [];
  private status = "initializing";

  init(): InitContinue<{ endpoints: string[] }> {
    console.log("[Service] init() - preparing to connect");
    return {
      continue: {
        endpoints: ["api.example.com", "db.example.com", "cache.example.com"],
      },
    };
  }

  async handleContinue(data: { endpoints: string[] }): Promise<void> {
    console.log(`[Service] handleContinue() - connecting to ${data.endpoints.length} endpoints...`);

    for (const endpoint of data.endpoints) {
      await this.connectTo(endpoint);
      this.connections.push(endpoint);
    }

    this.status = "ready";
    console.log("[Service] handleContinue() - all connections established!");
  }

  private async connectTo(endpoint: string): Promise<void> {
    // Simulate connection
    await sleep(50);
    console.log(`[Service] Connected to ${endpoint}`);
  }

  handleCall(message: any) {
    if (message.type === "getStatus") {
      return this.status;
    } else if (message.type === "getConnections") {
      return this.connections;
    }
    return null;
  }

  terminate() {
    console.log("[Service] Terminated - closing connections");
  }
}

// --- Main ---

async function main() {
  console.log("=== handleContinue Example ===\n");
  console.log("handleContinue allows expensive async initialization without");
  console.log("blocking spawn(). init() returns quickly, then handleContinue()");
  console.log("runs asynchronously in the background.\n");

  const cluster = new LocalCluster("node1");
  const transport = new InMemoryTransport(cluster.nodeId);
  const registry = new LocalRegistry();
  const system = new ActorSystem(cluster, transport, registry);
  await system.start();

  try {
    // Demo 1: User session with async data loading
    console.log("--- Demo 1: User Session (async data loading) ---\n");

    const session = system.spawn(UserSessionActor, { args: ["user-123"] });
    console.log("spawn() returned immediately!\n");

    // Check readiness over time
    let ready = await session.call({ type: "isReady" });
    console.log(`Ready immediately after spawn: ${ready}`);

    await sleep(150);
    ready = await session.call({ type: "isReady" });
    console.log(`Ready after 150ms: ${ready}`);

    const user = await session.call({ type: "getUser" });
    console.log(`User data: ${JSON.stringify(user)}\n`);

    // Demo 2: Config manager with parallel loading
    console.log("\n--- Demo 2: Config Manager (parallel loading) ---\n");

    const configManager = system.spawn(ConfigManagerActor);
    console.log("spawn() returned immediately!\n");

    await sleep(200);

    const config = await configManager.call({ type: "getConfig" });
    console.log(`Loaded config: ${JSON.stringify(config, null, 2)}\n`);

    // Demo 3: Cache with optional warmup
    console.log("\n--- Demo 3: Cache (conditional continue) ---\n");

    // Cache without warmup - no handleContinue called
    console.log("Creating cache WITHOUT warmup:");
    const coldCache = system.spawn(CacheActor);
    await sleep(50);
    let warmedUp = await coldCache.call({ type: "isWarmedUp" });
    console.log(`Warmed up: ${warmedUp}\n`);

    // Cache with warmup - handleContinue called
    console.log("Creating cache WITH warmup:");
    const warmCache = system.spawn(CacheActor, {
      args: [["user:1", "user:2", "config:main"]],
    });

    await sleep(50);
    warmedUp = await warmCache.call({ type: "isWarmedUp" });
    console.log(`Warmed up immediately: ${warmedUp}`);

    await sleep(250);
    warmedUp = await warmCache.call({ type: "isWarmedUp" });
    const size = await warmCache.call({ type: "size" });
    console.log(`Warmed up after 250ms: ${warmedUp}, cache size: ${size}\n`);

    // Demo 4: Service with sequential connections
    console.log("\n--- Demo 4: Service (sequential connections) ---\n");

    const service = system.spawn(ServiceActor);
    console.log("spawn() returned immediately!\n");

    let status = await service.call({ type: "getStatus" });
    console.log(`Status immediately: ${status}`);

    await sleep(200);
    status = await service.call({ type: "getStatus" });
    const connections = await service.call({ type: "getConnections" });
    console.log(`Status after 200ms: ${status}`);
    console.log(`Connections: ${JSON.stringify(connections)}\n`);

    // Cleanup
    await system.shutdown();
  } catch (err) {
    console.error("Error:", err);
    await system.shutdown();
  }

  console.log("=== Done ===");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
