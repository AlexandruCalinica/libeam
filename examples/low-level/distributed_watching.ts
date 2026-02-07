// examples/distributed_watching.ts
//
// Demonstrates: Distributed actor watching across nodes
// Prerequisites: None (uses in-memory transport for simplicity)
// Run: npx ts-node examples/distributed_watching.ts
//
// This example shows how actors on one node can watch actors on another node
// and receive DOWN notifications when the remote actors terminate.
//
// Key features demonstrated:
// 1. Remote watch setup - Actor on node1 watches actor on node2
// 2. Remote DOWN notification - When remote actor dies, watcher is notified
// 3. Node failure handling - When a node fails, all watchers are notified

import {
  Actor,
  ActorRef,
  ActorSystem,
  LocalCluster,
  InMemoryTransport,
  LocalRegistry,
  DownMessage,
  InfoMessage,
} from "../../src";



// --- Actor Definitions ---

/**
 * A service actor that provides some functionality.
 * When it receives "shutdown", it gracefully stops.
 * When it receives "crash", it throws an error to simulate a failure.
 */
class ServiceActor extends Actor {
  private serviceName = "unknown";

  init(serviceName: string): void {
    this.serviceName = serviceName;
    console.log(
      `  [${this.serviceName}] Service started on ${this.self.id.systemId}`,
    );
  }

  handleCast(message: any): void {
    if (message.type === "shutdown") {
      console.log(`  [${this.serviceName}] Shutting down gracefully`);
      this.context.system.stop(this.self);
    } else if (message.type === "crash") {
      console.log(`  [${this.serviceName}] Crashing!`);
      throw new Error(`${this.serviceName} crashed`);
    } else if (message.type === "work") {
      console.log(`  [${this.serviceName}] Processing task: ${message.task}`);
    }
  }

  handleCall(message: any): any {
    if (message.type === "status") {
      return { status: `${this.serviceName} is running` };
    }
    return null;
  }

  terminate(): void {
    console.log(`  [${this.serviceName}] Terminated`);
  }
}

/**
 * A supervisor actor that watches remote service actors.
 * When a watched service dies, it logs the event and could take recovery action.
 */
class SupervisorActor extends Actor {
  private watchedServices = new Map<string, ActorRef>();

  init(): void {
    console.log(`  [Supervisor] Started on ${this.self.id.systemId}`);
  }

  handleCast(message: any): void {
    if (message.type === "watch") {
      console.log(
        `  [Supervisor] Now watching "${message.name}" on ${message.serviceRef.id.systemId}`,
      );
      this.watch(message.serviceRef);
      this.watchedServices.set(message.name, message.serviceRef);
    }
  }

  handleCall(message: any): any {
    if (message.type === "getWatchedCount") {
      return { watchedCount: this.watchedServices.size };
    }
    return null;
  }

  handleInfo(message: InfoMessage): void {
    if (message.type === "down") {
      const downMsg = message as DownMessage;
      const actorId = downMsg.actorRef.id.id;
      const nodeId = downMsg.actorRef.id.systemId;
      const reason = downMsg.reason.type;

      // Find the service name
      let serviceName = "unknown";
      for (const [name, ref] of this.watchedServices.entries()) {
        if (ref.id.id === actorId) {
          serviceName = name;
          this.watchedServices.delete(name);
          break;
        }
      }

      console.log(
        `  [Supervisor] Received DOWN for "${serviceName}" on ${nodeId} (reason: ${reason})`,
      );

      // In a real system, you might restart the service or notify other systems
      if (reason === "killed") {
        console.log(
          `  [Supervisor] Service "${serviceName}" was killed - node may have failed`,
        );
      } else if (reason === "error") {
        console.log(
          `  [Supervisor] Service "${serviceName}" crashed - may need investigation`,
        );
      } else {
        console.log(`  [Supervisor] Service "${serviceName}" stopped normally`);
      }
    }
  }
}

// --- Main ---

async function main() {
  console.log("=== Distributed Actor Watching Example ===\n");

  // Create two nodes with connected transports
  const cluster1 = new LocalCluster("node1");
  const cluster2 = new LocalCluster("node2");

  const transport1 = new InMemoryTransport("node1");
  const transport2 = new InMemoryTransport("node2");

  // Connect transports bidirectionally
  transport1.setPeer("node2", transport2);
  transport2.setPeer("node1", transport1);

  const registry1 = new LocalRegistry();
  const registry2 = new LocalRegistry();

  const node1 = new ActorSystem(cluster1, transport1, registry1, {
    strategy: "Stop", // Stop actors on crash for this demo
    maxRestarts: 0,
    periodMs: 5000,
  });

  const node2 = new ActorSystem(cluster2, transport2, registry2, {
    strategy: "Stop",
    maxRestarts: 0,
    periodMs: 5000,
  });

  await node1.start();
  await node2.start();

  try {
    // --- Demo 1: Basic Remote Watching ---
    console.log("--- Demo 1: Basic Remote Watching ---\n");

    // Supervisor on node1
    const supervisor = node1.spawn(SupervisorActor);

    // Services on node2
    const authService = node2.spawn(ServiceActor, { args: ["AuthService"] });
    const dbService = node2.spawn(ServiceActor, { args: ["DatabaseService"] });

    await sleep(50);

    // Supervisor watches the remote services
    supervisor.cast({ type: "watch", name: "auth", serviceRef: authService });
    supervisor.cast({ type: "watch", name: "db", serviceRef: dbService });

    await sleep(50);

    // Verify services are running
    const authStatus = await authService.call({ type: "status" });
    console.log(`  Auth service status: ${authStatus.status}`);

    // --- Demo 2: Graceful Shutdown Notification ---
    console.log("\n--- Demo 2: Graceful Shutdown ---\n");

    // Gracefully shut down auth service
    authService.cast({ type: "shutdown" });
    await sleep(100);
    // Supervisor should receive DOWN with reason "normal"

    // --- Demo 3: Crash Notification ---
    console.log("\n--- Demo 3: Service Crash ---\n");

    // Crash the database service
    dbService.cast({ type: "crash" });
    await sleep(100);
    // Supervisor should receive DOWN with reason "killed" (stopped after crash)

    // --- Demo 4: Node Failure ---
    console.log("\n--- Demo 4: Node Failure Simulation ---\n");

    // Spawn new services on node2
    const cacheService = node2.spawn(ServiceActor, { args: ["CacheService"] });
    const queueService = node2.spawn(ServiceActor, { args: ["QueueService"] });

    await sleep(50);

    // Watch the new services
    supervisor.cast({ type: "watch", name: "cache", serviceRef: cacheService });
    supervisor.cast({ type: "watch", name: "queue", serviceRef: queueService });

    await sleep(50);

    // Simulate node2 failure - this notifies all watchers
    console.log("  Simulating node2 failure...\n");
    node1.handleNodeFailure("node2");

    await sleep(100);
    // Supervisor should receive DOWN for both services with reason "killed"

    console.log("\n--- Demo Complete ---");
  } finally {
    await node1.shutdown();
    await node2.shutdown();
  }

  console.log("\n=== Done ===");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
