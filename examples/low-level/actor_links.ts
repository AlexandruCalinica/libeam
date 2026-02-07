// examples/actor_links.ts
//
// Demonstrates: Actor links for bidirectional crash propagation
// Prerequisites: None
// Run: npx ts-node examples/actor_links.ts

import {
  Actor,
  ActorSystem,
  ActorRef,
  LocalCluster,
  InMemoryTransport,
  LocalRegistry,
  LinkRef,
  InfoMessage,
  ExitMessage,
} from "../../src";



// --- Actor Definitions ---

/**
 * A worker actor that can crash on command.
 * Used to demonstrate link propagation.
 */
class WorkerActor extends Actor {
  private name: string = "";
  private workDone = 0;

  init(name: string) {
    this.name = name;
    console.log(`[${this.name}] Started`);
  }

  handleCast(message: any) {
    if (message.type === "work") {
      this.workDone++;
      console.log(`[${this.name}] Did work #${this.workDone}`);
    } else if (message.type === "crash") {
      console.log(`[${this.name}] Crashing!`);
      throw new Error(`${this.name} crashed`);
    }
  }

  handleCall(message: any) {
    if (message.type === "getWorkDone") {
      return this.workDone;
    }
    return null;
  }

  terminate() {
    console.log(`[${this.name}] Terminated`);
  }
}

/**
 * A coordinator that links to workers.
 * If a worker crashes, the coordinator crashes too (unless trapExit is enabled).
 */
class CoordinatorActor extends Actor {
  private name: string = "";
  private workerLinks = new Map<string, { ref: ActorRef; link: LinkRef }>();

  init(name: string) {
    this.name = name;
    console.log(`[Coordinator:${this.name}] Started`);
  }

  handleCast(message: any) {
    if (message.type === "linkWorker") {
      const linkRef = this.link(message.workerRef);
      this.workerLinks.set(message.workerId, {
        ref: message.workerRef,
        link: linkRef,
      });
      console.log(`[Coordinator:${this.name}] Linked to ${message.workerId}`);
    } else if (message.type === "unlinkWorker") {
      const entry = this.workerLinks.get(message.workerId);
      if (entry) {
        this.unlink(entry.link);
        this.workerLinks.delete(message.workerId);
        console.log(`[Coordinator:${this.name}] Unlinked from ${message.workerId}`);
      }
    } else if (message.type === "crash") {
      console.log(`[Coordinator:${this.name}] Crashing!`);
      throw new Error(`Coordinator ${this.name} crashed`);
    }
  }

  handleCall(message: any) {
    if (message.type === "getLinkedWorkers") {
      return Array.from(this.workerLinks.keys());
    }
    return null;
  }

  terminate() {
    console.log(`[Coordinator:${this.name}] Terminated`);
  }
}

/**
 * A supervisor actor that uses trapExit to handle worker crashes gracefully.
 * Instead of crashing when a linked actor crashes, it receives an ExitMessage.
 */
class SupervisorActor extends Actor {
  private name: string = "";
  private workers = new Map<string, { ref: ActorRef; link: LinkRef }>();
  private exitLog: Array<{ workerId: string; reason: string }> = [];

  init(name: string) {
    this.name = name;
    // Enable trapExit to receive exit messages instead of crashing
    this.setTrapExit(true);
    console.log(`[Supervisor:${this.name}] Started (trapExit enabled)`);
  }

  handleCast(message: any) {
    if (message.type === "linkWorker") {
      const linkRef = this.link(message.workerRef);
      this.workers.set(message.workerId, {
        ref: message.workerRef,
        link: linkRef,
      });
      console.log(`[Supervisor:${this.name}] Linked to ${message.workerId}`);
    }
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "exit") {
      const exitMsg = message as ExitMessage;
      // Find which worker this was
      let workerId = "unknown";
      for (const [id, entry] of this.workers.entries()) {
        if (entry.ref.id.id === exitMsg.actorRef.id.id) {
          workerId = id;
          this.workers.delete(id);
          break;
        }
      }

      console.log(
        `[Supervisor:${this.name}] Received EXIT from ${workerId}: ${exitMsg.reason.type}`,
      );
      this.exitLog.push({ workerId, reason: exitMsg.reason.type });

      // In a real system, you might restart the worker here
      console.log(`[Supervisor:${this.name}] Could restart ${workerId} here...`);
    }
  }

  handleCall(message: any) {
    if (message.type === "getWorkers") {
      return Array.from(this.workers.keys());
    } else if (message.type === "getExitLog") {
      return this.exitLog;
    } else if (message.type === "isTrapExitEnabled") {
      return this.isTrapExit();
    }
    return null;
  }

  terminate() {
    console.log(`[Supervisor:${this.name}] Terminated`);
  }
}

/**
 * A pair of linked actors that demonstrate bidirectional crash propagation.
 */
class PairedActor extends Actor {
  private name: string = "";
  private partnerId?: string;
  private partnerLink?: LinkRef;

  init(name: string) {
    this.name = name;
    console.log(`[Paired:${this.name}] Started`);
  }

  handleCast(message: any) {
    if (message.type === "linkPartner") {
      this.partnerLink = this.link(message.partnerRef);
      this.partnerId = message.partnerId;
      console.log(`[Paired:${this.name}] Linked to partner ${this.partnerId}`);
    } else if (message.type === "crash") {
      console.log(`[Paired:${this.name}] Crashing!`);
      throw new Error(`${this.name} crashed`);
    }
  }

  handleCall(message: any) {
    if (message.type === "getPartner") {
      return this.partnerId;
    }
    return null;
  }

  terminate() {
    console.log(`[Paired:${this.name}] Terminated`);
  }
}

// --- Main ---

async function main() {
  console.log("=== Actor Links Example ===\n");
  console.log("Actor links provide bidirectional crash propagation.");
  console.log("When a linked actor crashes, the other crashes too");
  console.log("(unless trapExit is enabled).\n");

  const cluster = new LocalCluster("node1");
  const transport = new InMemoryTransport(cluster.nodeId);
  const registry = new LocalRegistry();
  const system = new ActorSystem(cluster, transport, registry, {
    strategy: "Stop",
    maxRestarts: 0,
    periodMs: 5000,
  });
  await system.start();

  try {
    // Demo 1: Basic link - coordinator crashes when worker crashes
    console.log("--- Demo 1: Basic Link (crash propagation) ---\n");

    const worker1 = system.spawn(WorkerActor, { args: ["Worker-1"] });
    const coord1 = system.spawn(CoordinatorActor, { args: ["Coord-1"] });

    coord1.cast({ type: "linkWorker", workerRef: worker1, workerId: "Worker-1" });
    await sleep(50);

    console.log("\nCrashing Worker-1...\n");
    worker1.cast({ type: "crash" });
    await sleep(100);

    // Both should be gone
    const actorIds = system.getLocalActorIds();
    console.log(`\nRemaining actors: ${actorIds.length}`);
    console.log("(Both worker and coordinator crashed due to link)\n");

    // Demo 2: Unlink before crash - coordinator survives
    console.log("\n--- Demo 2: Unlink Before Crash ---\n");

    const worker2 = system.spawn(WorkerActor, { args: ["Worker-2"] });
    const coord2 = system.spawn(CoordinatorActor, { args: ["Coord-2"] });

    coord2.cast({ type: "linkWorker", workerRef: worker2, workerId: "Worker-2" });
    await sleep(50);

    // Unlink before crashing
    coord2.cast({ type: "unlinkWorker", workerId: "Worker-2" });
    await sleep(50);

    console.log("\nCrashing Worker-2 (after unlink)...\n");
    worker2.cast({ type: "crash" });
    await sleep(100);

    // Coordinator should survive
    const linked = await coord2.call({ type: "getLinkedWorkers" });
    console.log(`Coordinator is alive! Linked workers: ${JSON.stringify(linked)}`);
    console.log("(Coordinator survived because we unlinked first)\n");

    await system.stop(coord2);

    // Demo 3: trapExit - supervisor handles crashes gracefully
    console.log("\n--- Demo 3: trapExit (graceful crash handling) ---\n");

    const supervisor = system.spawn(SupervisorActor, { args: ["Supervisor-1"] });
    const worker3 = system.spawn(WorkerActor, { args: ["Worker-3"] });
    const worker4 = system.spawn(WorkerActor, { args: ["Worker-4"] });

    supervisor.cast({ type: "linkWorker", workerRef: worker3, workerId: "Worker-3" });
    supervisor.cast({ type: "linkWorker", workerRef: worker4, workerId: "Worker-4" });
    await sleep(50);

    const trapEnabled = await supervisor.call({ type: "isTrapExitEnabled" });
    console.log(`\nSupervisor trapExit enabled: ${trapEnabled}`);

    console.log("\nCrashing Worker-3...\n");
    worker3.cast({ type: "crash" });
    await sleep(100);

    // Supervisor should receive ExitMessage, not crash
    let workers = await supervisor.call({ type: "getWorkers" });
    console.log(`\nSupervisor alive! Remaining workers: ${JSON.stringify(workers)}`);

    console.log("\nCrashing Worker-4...\n");
    worker4.cast({ type: "crash" });
    await sleep(100);

    workers = await supervisor.call({ type: "getWorkers" });
    const exitLog = await supervisor.call({ type: "getExitLog" });
    console.log(`Supervisor alive! Remaining workers: ${JSON.stringify(workers)}`);
    console.log(`Exit log: ${JSON.stringify(exitLog)}`);
    console.log("(Supervisor survived both crashes via trapExit)\n");

    await system.stop(supervisor);

    // Demo 4: Bidirectional links - either side can trigger crash
    console.log("\n--- Demo 4: Bidirectional Links ---\n");

    const alice = system.spawn(PairedActor, { args: ["Alice"] });
    const bob = system.spawn(PairedActor, { args: ["Bob"] });

    // Link from both sides (either one would work, links are bidirectional)
    alice.cast({ type: "linkPartner", partnerRef: bob, partnerId: "Bob" });
    await sleep(50);

    console.log("\nCrashing Alice (Bob should crash too)...\n");
    alice.cast({ type: "crash" });
    await sleep(100);

    const remaining = system.getLocalActorIds();
    console.log(`Remaining actors: ${remaining.length}`);
    console.log("(Both Alice and Bob crashed - link is bidirectional)\n");

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
