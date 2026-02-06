// examples/actor_watching.ts
//
// Demonstrates: Monitoring actor termination with watch/unwatch
// Prerequisites: None
// Run: npx ts-node examples/actor_watching.ts
//
// This example shows:
// - watch() to monitor another actor for termination
// - handleInfo() to receive DOWN messages when watched actors terminate
// - unwatch() to stop monitoring
// - Different termination reasons (normal, error, killed)
// - Using watching for cleanup and resource management

import {
  Actor,
  ActorRef,
  ActorSystem,
  Cluster,
  LocalRegistry,
  InMemoryTransport,
  WatchRef,
  DownMessage,
  InfoMessage,
} from "../src";

// --- Worker Actor (can be terminated) ---

class WorkerActor extends Actor {
  private name = "";

  init(name: string) {
    this.name = name;
    console.log(`  [${this.name}] Started`);
  }

  terminate() {
    console.log(`  [${this.name}] Terminated`);
  }

  handleCast(message: any): void {
    if (message.type === "crash") {
      console.log(`  [${this.name}] Crashing!`);
      throw new Error(`${this.name} crashed`);
    }
    if (message.type === "work") {
      console.log(`  [${this.name}] Working...`);
    }
  }

  handleCall(message: any): any {
    return `${this.name} says hello`;
  }
}

// --- Monitor Actor (watches other actors) ---

class MonitorActor extends Actor {
  private watchedActors = new Map<
    string,
    { name: string; watchRef: WatchRef }
  >();
  private terminationLog: string[] = [];

  init() {
    console.log("[Monitor] Started - I watch other actors for termination");
  }

  handleCast(message: any): void {
    if (message.type === "watch") {
      const actorRef: ActorRef = message.actorRef;
      const name: string = message.name;

      // Start watching the actor
      const watchRef = this.watch(actorRef);
      this.watchedActors.set(actorRef.id.id, { name, watchRef });

      console.log(`[Monitor] Now watching: ${name}`);
    }

    if (message.type === "unwatch") {
      const actorRef: ActorRef = message.actorRef;
      const entry = this.watchedActors.get(actorRef.id.id);

      if (entry) {
        this.unwatch(entry.watchRef);
        this.watchedActors.delete(actorRef.id.id);
        console.log(`[Monitor] Stopped watching: ${entry.name}`);
      }
    }
  }

  handleCall(message: any): any {
    if (message.type === "getLog") {
      return [...this.terminationLog];
    }
    if (message.type === "getWatchCount") {
      return this.watchedActors.size;
    }
    return null;
  }

  /**
   * Called when a watched actor terminates.
   * This is the key method for handling actor termination notifications.
   */
  handleInfo(message: InfoMessage): void {
    if (message.type === "down") {
      const downMsg = message as DownMessage;
      const entry = this.watchedActors.get(downMsg.actorRef.id.id);
      const actorName = entry?.name || "unknown";

      let reasonStr: string;
      switch (downMsg.reason.type) {
        case "normal":
          reasonStr = "normally";
          break;
        case "error":
          reasonStr = `with error: ${downMsg.reason.error}`;
          break;
        case "killed":
          reasonStr = "killed";
          break;
      }

      const logEntry = `${actorName} terminated ${reasonStr}`;
      this.terminationLog.push(logEntry);

      console.log(`[Monitor] Received DOWN: ${logEntry}`);

      // Clean up our watch tracking
      this.watchedActors.delete(downMsg.actorRef.id.id);
    }
  }
}

// --- Service Registry (practical use case) ---
// Demonstrates watching external actors (not children) for automatic cleanup

class ServiceActor extends Actor {
  private name = "";

  init(name: string) {
    this.name = name;
    console.log(`  [Service:${this.name}] Online`);
  }

  terminate() {
    console.log(`  [Service:${this.name}] Offline`);
  }

  handleCast(message: any): void {}
  handleCall(message: any): any {
    return `${this.name} is running`;
  }
}

/**
 * A service registry that watches registered services.
 * When a service terminates, it's automatically removed from the registry.
 * This is a common pattern for service discovery systems.
 */
class ServiceRegistry extends Actor {
  private services = new Map<string, { ref: ActorRef; watchRef: WatchRef }>();

  init() {
    console.log("[Registry] Service registry started");
  }

  handleCast(message: any): void {
    if (message.type === "register") {
      const name: string = message.name;
      const ref: ActorRef = message.ref;

      // Watch the service so we're notified when it terminates
      const watchRef = this.watch(ref);
      this.services.set(name, { ref, watchRef });

      console.log(`[Registry] Registered service: "${name}"`);
    }

    if (message.type === "deregister") {
      const name: string = message.name;
      const entry = this.services.get(name);
      if (entry) {
        this.unwatch(entry.watchRef);
        this.services.delete(name);
        console.log(`[Registry] Manually deregistered: "${name}"`);
      }
    }
  }

  handleCall(message: any): any {
    if (message.type === "list") {
      return Array.from(this.services.keys());
    }
    if (message.type === "lookup") {
      const entry = this.services.get(message.name);
      return entry?.ref || null;
    }
    return null;
  }

  handleInfo(message: InfoMessage): void {
    if (message.type === "down") {
      const downMsg = message as DownMessage;

      // Find which service terminated and remove it automatically
      for (const [name, entry] of this.services.entries()) {
        if (entry.ref.id.id === downMsg.actorRef.id.id) {
          console.log(
            `[Registry] Service "${name}" terminated - auto-removing from registry`,
          );
          this.services.delete(name);
          break;
        }
      }
    }
  }
}

// --- Mock Cluster ---

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// --- Helper ---

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  console.log("=== Actor Watching Example ===\n");

  // Setup
  const transport = new InMemoryTransport("node1");
  await transport.connect();
  const registry = new LocalRegistry();
  const cluster = new MockCluster("node1");
  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClasses([
    WorkerActor,
    MonitorActor,
    ServiceActor,
    ServiceRegistry,
  ]);
  await system.start();

  try {
    // === Demo 1: Basic Watching ===
    console.log("--- Demo 1: Basic Actor Watching ---\n");

    const monitor = system.spawn(MonitorActor);

    // Create some workers
    const worker1 = system.spawn(WorkerActor, { args: ["Worker-A"] });
    const worker2 = system.spawn(WorkerActor, { args: ["Worker-B"] });
    const worker3 = system.spawn(WorkerActor, { args: ["Worker-C"] });
    await delay(50);

    // Monitor watches all workers
    monitor.cast({ type: "watch", actorRef: worker1, name: "Worker-A" });
    monitor.cast({ type: "watch", actorRef: worker2, name: "Worker-B" });
    monitor.cast({ type: "watch", actorRef: worker3, name: "Worker-C" });
    await delay(50);

    let watchCount = await monitor.call({ type: "getWatchCount" });
    console.log(`\nMonitor is watching ${watchCount} actors\n`);

    // Stop worker1 normally
    console.log("Stopping Worker-A normally...");
    await system.stop(worker1);
    await delay(100);

    // Stop worker2 (simulating a failure that leads to shutdown)
    // Note: If we crashed it, the supervisor would restart it instead of terminating
    console.log(
      "\nStopping Worker-B (simulating controlled shutdown after error)...",
    );
    await system.stop(worker2);
    await delay(100);

    // Unwatch worker3 before stopping
    console.log("\nUnwatching Worker-C, then stopping...");
    monitor.cast({ type: "unwatch", actorRef: worker3 });
    await delay(50);
    await system.stop(worker3);
    await delay(100);

    // Check the log
    const log = await monitor.call({ type: "getLog" });
    console.log("\nTermination log:");
    log.forEach((entry: string) => console.log(`  - ${entry}`));
    console.log("(Worker-C not logged because we unwatched it first)\n");

    // === Demo 2: Service Registry with Auto-Cleanup ===
    console.log(
      "\n--- Demo 2: Service Registry with Watch-Based Cleanup ---\n",
    );

    const registry2 = system.spawn(ServiceRegistry);

    // Create some services (spawned at system level, not as children)
    const authService = system.spawn(ServiceActor, { args: ["auth"] });
    const dbService = system.spawn(ServiceActor, { args: ["database"] });
    const cacheService = system.spawn(ServiceActor, { args: ["cache"] });
    await delay(50);

    // Register services with the registry
    registry2.cast({ type: "register", name: "auth", ref: authService });
    registry2.cast({ type: "register", name: "database", ref: dbService });
    registry2.cast({ type: "register", name: "cache", ref: cacheService });
    await delay(50);

    let services = await registry2.call({ type: "list" });
    console.log(`\nRegistered services: ${JSON.stringify(services)}\n`);

    // Stop the database service - registry should auto-remove it
    console.log("Stopping database service...");
    await system.stop(dbService);
    await delay(100);

    services = await registry2.call({ type: "list" });
    console.log(`\nServices after db shutdown: ${JSON.stringify(services)}`);
    console.log(
      "(database was automatically removed via watch notification)\n",
    );
  } finally {
    // Cleanup
    await system.shutdown();
    await transport.disconnect();
  }

  console.log("=== Done ===");
}

main().catch(console.error);
