// examples/distributed_supervision.ts
//
// Demonstrates: Distributed actor supervision across nodes
// Prerequisites: None (uses in-memory transport for simplicity)
// Run: npx ts-node examples/distributed_supervision.ts
//
// This example shows how parent actors on one node can spawn and supervise
// child actors on remote nodes, with full supervision strategy support.
//
// Key features demonstrated:
// 1. Remote child spawning - Parent on node1 spawns supervised child on node2
// 2. Remote crash notification - When remote child crashes, parent is notified
// 3. Remote restart strategies - one-for-one, one-for-all, rest-for-one across nodes
// 4. Remote child lifecycle - Children stopped when parent stops
// 5. Node failure handling - Orphaned children cleaned up

import {
  Actor,
  ActorRef,
  ActorSystem,
  LocalCluster,
  InMemoryTransport,
  LocalRegistry,
  ChildSupervisionOptions,
} from "../../src";



// --- Actor Definitions ---

/**
 * A worker actor that processes tasks.
 * Can be crashed on demand to demonstrate supervision.
 */
class WorkerActor extends Actor {
  private workerName = "unknown";
  private processedCount = 0;

  init(workerName: string): void {
    this.workerName = workerName;
    console.log(`  [Worker:${this.workerName}] Started on ${this.self.id.systemId}`);
  }

  handleCast(message: any): void {
    if (message.type === "crash") {
      console.log(`  [Worker:${this.workerName}] Crashing!`);
      throw new Error(`${this.workerName} crashed intentionally`);
    } else if (message.type === "work") {
      this.processedCount++;
      console.log(`  [Worker:${this.workerName}] Processing task #${this.processedCount}: ${message.task}`);
    }
  }

  handleCall(message: any): any {
    if (message.type === "status") {
      return { name: this.workerName, processed: this.processedCount, node: this.self.id.systemId };
    }
    return null;
  }

  terminate(): void {
    console.log(`  [Worker:${this.workerName}] Terminated`);
  }
}

/**
 * A supervisor actor that spawns and supervises remote children.
 */
class SupervisorActor extends Actor {
  private supervisorName = "unknown";
  private strategy: "one-for-one" | "one-for-all" | "rest-for-one" = "one-for-one";

  init(
    supervisorName: string,
    strategy: "one-for-one" | "one-for-all" | "rest-for-one" = "one-for-one"
  ): void {
    this.supervisorName = supervisorName;
    this.strategy = strategy;
    console.log(
      `  [Supervisor:${this.supervisorName}] Started on ${this.self.id.systemId} (strategy: ${strategy})`
    );
  }

  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: this.strategy,
      maxRestarts: 3,
      periodMs: 10000,
    };
  }

  handleCast(message: any): void {
    if (message.type === "spawnRemote") {
      // Note: This is handled externally in the demo since spawnChildRemote is async
      console.log(`  [Supervisor:${this.supervisorName}] Received spawn request for ${message.workerName}`);
    }
  }

  handleCall(message: any): any {
    if (message.type === "getChildren") {
      const children = Array.from(this.context.children).map((ref) => ({
        id: ref.id.id,
        node: ref.id.systemId,
      }));
      return { children };
    }
    if (message.type === "getChildCount") {
      return { count: this.context.children.size };
    }
    return null;
  }

  terminate(): void {
    console.log(`  [Supervisor:${this.supervisorName}] Terminated`);
  }
}

// --- Main ---

async function main() {
  console.log("=== Distributed Actor Supervision Example ===\n");

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
    strategy: "Stop",
    maxRestarts: 0,
    periodMs: 5000,
  });

  const node2 = new ActorSystem(cluster2, transport2, registry2, {
    strategy: "Stop",
    maxRestarts: 0,
    periodMs: 5000,
  });

  // Register actor classes on both nodes (required for remote spawn)
  node1.registerActorClass(WorkerActor);
  node2.registerActorClass(WorkerActor);

  await node1.start();
  await node2.start();

  try {
    // --- Demo 1: Remote Child Spawning ---
    console.log("--- Demo 1: Remote Child Spawning ---\n");

    // Supervisor on node1
    const supervisor1 = node1.spawn(SupervisorActor, { args: ["S1", "one-for-one"] });
    await sleep(50);

    // Spawn remote child on node2
    console.log("  Spawning remote child W1 on node2...\n");
    const worker1 = await node1.spawnChildRemote(
      supervisor1,
      WorkerActor,
      "node2",
      { args: ["W1"] }
    );

    if (worker1) {
      console.log(`  Remote child spawned: ${worker1.id.id} on ${worker1.id.systemId}`);

      // Send work to remote child
      worker1.cast({ type: "work", task: "Process data" });
      await sleep(100);

      // Check status via call
      const status = await worker1.call({ type: "status" });
      console.log(`  Worker status: ${JSON.stringify(status)}`);

      // Verify parent knows about child
      const children = await supervisor1.call({ type: "getChildren" });
      console.log(`  Supervisor children: ${JSON.stringify(children)}\n`);
    }

    // --- Demo 2: Remote Child Crash with One-for-One Restart ---
    console.log("--- Demo 2: Remote Child Crash with One-for-One Restart ---\n");

    // Get child count before crash
    const countBefore = await supervisor1.call({ type: "getChildCount" });
    console.log(`  Children before crash: ${countBefore.count}`);

    // Crash the remote worker
    console.log("  Crashing W1...\n");
    worker1?.cast({ type: "crash" });
    await sleep(300);

    // Child should be restarted
    const countAfter = await supervisor1.call({ type: "getChildCount" });
    console.log(`  Children after crash (should still be 1): ${countAfter.count}`);

    const childrenAfter = await supervisor1.call({ type: "getChildren" });
    console.log(`  New child ref: ${JSON.stringify(childrenAfter)}\n`);

    // --- Demo 3: One-for-All Strategy ---
    console.log("--- Demo 3: One-for-All Strategy ---\n");

    // Create a new supervisor with one-for-all strategy
    const supervisor2 = node1.spawn(SupervisorActor, { args: ["S2", "one-for-all"] });
    await sleep(50);

    // Spawn multiple remote children
    const worker2 = await node1.spawnChildRemote(supervisor2, WorkerActor, "node2", { args: ["W2"] });
    const worker3 = await node1.spawnChildRemote(supervisor2, WorkerActor, "node2", { args: ["W3"] });
    const worker4 = await node1.spawnChildRemote(supervisor2, WorkerActor, "node2", { args: ["W4"] });
    await sleep(100);

    const count2Before = await supervisor2.call({ type: "getChildCount" });
    console.log(`  Children before crash: ${count2Before.count}`);

    // Crash W3 - all children should restart due to one-for-all
    console.log("  Crashing W3 (all children should restart)...\n");
    worker3?.cast({ type: "crash" });
    await sleep(400);

    const count2After = await supervisor2.call({ type: "getChildCount" });
    console.log(`  Children after one-for-all restart: ${count2After.count}`);

    const children2After = await supervisor2.call({ type: "getChildren" });
    console.log(`  New child refs: ${JSON.stringify(children2After)}\n`);

    // --- Demo 4: Parent Shutdown Stops Remote Children ---
    console.log("--- Demo 4: Parent Shutdown Stops Remote Children ---\n");

    // Check node2 actor count before stopping supervisor
    const node2HealthBefore = node2.getHealth();
    console.log(`  Node2 actors before supervisor stop: ${(node2HealthBefore.details as any).actorCount}`);

    // Stop supervisor - should cascade to remote children
    console.log("  Stopping supervisor S2...\n");
    await node1.stop(supervisor2);
    await sleep(200);

    // Check node2 actor count after
    const node2HealthAfter = node2.getHealth();
    console.log(`  Node2 actors after supervisor stop: ${(node2HealthAfter.details as any).actorCount}`);
    console.log("  (Remote children were stopped when parent stopped)\n");

    // --- Demo 5: Node Failure Handling ---
    console.log("--- Demo 5: Node Failure Handling ---\n");

    // Create supervisor with remote child
    const supervisor3 = node1.spawn(SupervisorActor, { args: ["S3", "one-for-one"] });
    await sleep(50);

    const worker5 = await node1.spawnChildRemote(supervisor3, WorkerActor, "node2", { args: ["W5"] });
    await sleep(100);

    const count3Before = await supervisor3.call({ type: "getChildCount" });
    console.log(`  Children before node failure: ${count3Before.count}`);

    // Simulate node2 failure
    console.log("  Simulating node2 failure...\n");
    node1.handleNodeFailure("node2");
    await sleep(300);

    // Supervisor should have handled the child crash notification
    // Since max restarts is 3 and we've restarted once, it would try to restart
    // But since node2 is "dead", the restart will fail
    const count3After = await supervisor3.call({ type: "getChildCount" });
    console.log(`  Children after node failure: ${count3After.count}`);
    console.log("  (Remote child was marked as dead due to node failure)\n");

    console.log("--- Demo Complete ---");
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
