// examples/distributed_linking.ts
//
// Demonstrates: Distributed actor linking across nodes
// Prerequisites: None (uses in-memory transport for simplicity)
// Run: npx ts-node examples/distributed_linking.ts
//
// This example shows how actors on one node can link to actors on another node
// for bidirectional crash propagation across the cluster.
//
// Key features demonstrated:
// 1. Remote link setup - Actor on node1 links to actor on node2
// 2. Remote crash propagation - When remote actor crashes, linked actor crashes too
// 3. trapExit with remote links - Linked actor can trap exits and handle gracefully
// 4. Node failure handling - When a node fails, all linked actors are notified

import {
  Actor,
  ActorRef,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  InMemoryRegistry,
  ExitMessage,
  InfoMessage,
} from "../src";

// --- Mock Cluster for Testing ---

class MockCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

// --- Actor Definitions ---

/**
 * A worker actor that processes tasks.
 * Can be crashed on demand to demonstrate link propagation.
 */
class WorkerActor extends Actor {
  private workerName = "unknown";

  init(workerName: string): void {
    this.workerName = workerName;
    console.log(`  [${this.workerName}] Started on ${this.self.id.systemId}`);
  }

  handleCast(message: any): void {
    if (message.type === "crash") {
      console.log(`  [${this.workerName}] Crashing!`);
      throw new Error(`${this.workerName} crashed`);
    } else if (message.type === "work") {
      console.log(`  [${this.workerName}] Processing: ${message.task}`);
    } else if (message.type === "shutdown") {
      console.log(`  [${this.workerName}] Shutting down gracefully`);
      this.context.system.stop(this.self);
    }
  }

  handleCall(message: any): any {
    if (message.type === "status") {
      return { name: this.workerName, status: "running" };
    }
    return null;
  }

  terminate(): void {
    console.log(`  [${this.workerName}] Terminated`);
  }
}

/**
 * A coordinator that links to remote workers.
 * Without trapExit, it will crash when linked workers crash.
 */
class CoordinatorActor extends Actor {
  private coordName = "unknown";
  private linkedWorkers: string[] = [];

  init(coordName: string): void {
    this.coordName = coordName;
    console.log(
      `  [Coordinator:${this.coordName}] Started on ${this.self.id.systemId}`,
    );
  }

  handleCast(message: any): void {
    if (message.type === "link") {
      console.log(
        `  [Coordinator:${this.coordName}] Linking to ${message.workerName} on ${message.workerRef.id.systemId}`,
      );
      this.link(message.workerRef);
      this.linkedWorkers.push(message.workerName);
    } else if (message.type === "unlink") {
      console.log(
        `  [Coordinator:${this.coordName}] Unlinking from ${message.workerName}`,
      );
      this.unlink(message.linkRef);
      this.linkedWorkers = this.linkedWorkers.filter(
        (w) => w !== message.workerName,
      );
    }
  }

  handleCall(message: any): any {
    if (message.type === "getLinkedWorkers") {
      return { workers: [...this.linkedWorkers] };
    }
    return null;
  }

  terminate(): void {
    console.log(`  [Coordinator:${this.coordName}] Terminated`);
  }
}

/**
 * A supervisor that links to remote workers but traps exits.
 * This allows it to handle worker crashes gracefully without crashing itself.
 */
class SupervisorActor extends Actor {
  private supervisorName = "unknown";
  private linkedWorkers = new Map<string, ActorRef>();
  private exitLog: Array<{ workerId: string; reason: string }> = [];

  init(supervisorName: string, trapExit: boolean = true): void {
    this.supervisorName = supervisorName;
    this.context.trapExit = trapExit;
    console.log(
      `  [Supervisor:${this.supervisorName}] Started on ${this.self.id.systemId} (trapExit: ${trapExit})`,
    );
  }

  handleCast(message: any): void {
    if (message.type === "link") {
      console.log(
        `  [Supervisor:${this.supervisorName}] Linking to ${message.workerName} on ${message.workerRef.id.systemId}`,
      );
      this.link(message.workerRef);
      this.linkedWorkers.set(message.workerName, message.workerRef);
    }
  }

  handleCall(message: any): any {
    if (message.type === "getLinkedWorkers") {
      return { workers: Array.from(this.linkedWorkers.keys()) };
    }
    if (message.type === "getExitLog") {
      return { exitLog: [...this.exitLog] };
    }
    if (message.type === "isAlive") {
      return { alive: true };
    }
    return null;
  }

  handleInfo(message: InfoMessage): void {
    if (message.type === "exit") {
      const exitMsg = message as ExitMessage;
      const actorId = exitMsg.actorRef.id.id;
      const nodeId = exitMsg.actorRef.id.systemId;
      const reason = exitMsg.reason.type;

      // Find the worker name
      let workerName = "unknown";
      for (const [name, ref] of this.linkedWorkers.entries()) {
        if (ref.id.id === actorId) {
          workerName = name;
          this.linkedWorkers.delete(name);
          break;
        }
      }

      console.log(
        `  [Supervisor:${this.supervisorName}] Received EXIT from ${workerName}@${nodeId}: ${reason}`,
      );
      this.exitLog.push({ workerId: workerName, reason });

      // In a real system, you might restart the worker here
      console.log(
        `  [Supervisor:${this.supervisorName}] Could restart ${workerName} here...`,
      );
    }
  }

  terminate(): void {
    console.log(`  [Supervisor:${this.supervisorName}] Terminated`);
  }
}

// --- Main ---

async function main() {
  console.log("=== Distributed Actor Linking Example ===\n");

  // Create two nodes with connected transports
  const cluster1 = new MockCluster("node1");
  const cluster2 = new MockCluster("node2");

  const transport1 = new InMemoryTransport("node1");
  const transport2 = new InMemoryTransport("node2");

  // Connect transports bidirectionally
  transport1.setPeer("node2", transport2);
  transport2.setPeer("node1", transport1);

  const registry1 = new InMemoryRegistry();
  const registry2 = new InMemoryRegistry();

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
    // --- Demo 1: Basic Remote Linking (crash propagation) ---
    console.log("--- Demo 1: Basic Remote Linking (crash propagation) ---\n");

    // Coordinator on node1, Worker on node2
    const coord1 = node1.spawn(CoordinatorActor, { args: ["C1"] });
    const worker1 = node2.spawn(WorkerActor, { args: ["W1"] });

    await sleep(50);

    // Link coordinator to remote worker
    coord1.cast({ type: "link", workerName: "W1", workerRef: worker1 });
    await sleep(100);

    // Verify link is established
    const linkedWorkers = await coord1.call({ type: "getLinkedWorkers" });
    console.log(
      `  Coordinator linked to: ${JSON.stringify(linkedWorkers.workers)}`,
    );

    // Crash the worker - coordinator should also crash due to link
    console.log("\n  Crashing W1 (coordinator should crash too)...\n");
    worker1.cast({ type: "crash" });
    await sleep(200);

    // Check if coordinator is still alive (it shouldn't be)
    const health = node1.getHealth();
    const coord1Exists = (health.details as any).actorCount;
    console.log(`  Node1 actor count after crash: ${coord1Exists}`);
    console.log("  (Coordinator crashed due to linked worker crash)\n");

    // --- Demo 2: Remote Link with trapExit ---
    console.log("--- Demo 2: Remote Link with trapExit ---\n");

    // Supervisor on node1 (trapExit enabled), Workers on node2
    const supervisor = node1.spawn(SupervisorActor, { args: ["S1", true] });
    const worker2 = node2.spawn(WorkerActor, { args: ["W2"] });
    const worker3 = node2.spawn(WorkerActor, { args: ["W3"] });

    await sleep(50);

    // Link supervisor to remote workers
    supervisor.cast({ type: "link", workerName: "W2", workerRef: worker2 });
    supervisor.cast({ type: "link", workerName: "W3", workerRef: worker3 });
    await sleep(100);

    // Verify links
    const linked = await supervisor.call({ type: "getLinkedWorkers" });
    console.log(`  Supervisor linked to: ${JSON.stringify(linked.workers)}`);

    // Crash W2 - supervisor should receive EXIT message but not crash
    console.log("\n  Crashing W2 (supervisor traps exit)...\n");
    worker2.cast({ type: "crash" });
    await sleep(200);

    // Check supervisor is still alive
    const aliveCheck = await supervisor.call({ type: "isAlive" });
    console.log(`  Supervisor still alive: ${aliveCheck.alive}`);

    // Check exit log
    const exitLog1 = await supervisor.call({ type: "getExitLog" });
    console.log(`  Exit log: ${JSON.stringify(exitLog1.exitLog)}`);

    // Remaining workers
    const remainingWorkers = await supervisor.call({
      type: "getLinkedWorkers",
    });
    console.log(
      `  Remaining linked workers: ${JSON.stringify(remainingWorkers.workers)}\n`,
    );

    // --- Demo 3: Graceful Shutdown ---
    console.log("--- Demo 3: Graceful Shutdown ---\n");

    // Gracefully shut down W3
    worker3.cast({ type: "shutdown" });
    await sleep(200);

    // Check exit log - should show normal termination
    const exitLog2 = await supervisor.call({ type: "getExitLog" });
    console.log(
      `  Exit log after graceful shutdown: ${JSON.stringify(exitLog2.exitLog)}`,
    );
    console.log("  (Normal terminations don't propagate to linked actors)\n");

    // --- Demo 4: Node Failure ---
    console.log("--- Demo 4: Node Failure Simulation ---\n");

    // Spawn new workers on node2
    const worker4 = node2.spawn(WorkerActor, { args: ["W4"] });
    const worker5 = node2.spawn(WorkerActor, { args: ["W5"] });

    await sleep(50);

    // Link supervisor to new workers
    supervisor.cast({ type: "link", workerName: "W4", workerRef: worker4 });
    supervisor.cast({ type: "link", workerName: "W5", workerRef: worker5 });
    await sleep(100);

    const beforeFailure = await supervisor.call({ type: "getLinkedWorkers" });
    console.log(
      `  Linked workers before node failure: ${JSON.stringify(beforeFailure.workers)}`,
    );

    // Simulate node2 failure
    console.log("\n  Simulating node2 failure...\n");
    node1.handleNodeFailure("node2");
    await sleep(200);

    // Check exit log
    const exitLog3 = await supervisor.call({ type: "getExitLog" });
    console.log(
      `  Exit log after node failure: ${JSON.stringify(exitLog3.exitLog)}`,
    );

    const afterFailure = await supervisor.call({ type: "getLinkedWorkers" });
    console.log(
      `  Linked workers after node failure: ${JSON.stringify(afterFailure.workers)}`,
    );
    console.log("  (All workers from failed node triggered EXIT signals)\n");

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
