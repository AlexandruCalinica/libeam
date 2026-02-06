// examples/supervision_tree.ts
//
// Demonstrates: Parent-child supervision with different strategies
// Prerequisites: None
// Run: npx ts-node examples/supervision_tree.ts
//
// This example shows:
// - Spawning child actors under parent supervision
// - one-for-one: Only restart the crashed child
// - one-for-all: Restart all children when one crashes
// - rest-for-one: Restart crashed child and all children spawned after it
// - Max restart limits to prevent infinite restart loops

import {
  Actor,
  ActorRef,
  ActorSystem,
  LocalCluster,
  LocalRegistry,
  InMemoryTransport,
  ChildSupervisionOptions,
} from "../src";

// --- Worker Actor (can crash on demand) ---

class WorkerActor extends Actor {
  private name = "";
  private workCount = 0;

  init(name: string) {
    this.name = name;
    console.log(`  [${this.name}] Started (new instance)`);
  }

  terminate() {
    console.log(`  [${this.name}] Terminated`);
  }

  handleCast(message: any): void {
    if (message.type === "work") {
      this.workCount++;
      console.log(`  [${this.name}] Did work #${this.workCount}`);
    } else if (message.type === "crash") {
      console.log(`  [${this.name}] Crashing!`);
      throw new Error(`${this.name} crashed`);
    }
  }

  handleCall(message: any): any {
    if (message.type === "status") {
      return { name: this.name, workCount: this.workCount };
    }
    return null;
  }
}

// --- Supervisor with one-for-one strategy (default) ---

class OneForOneSupervisor extends Actor {
  init() {
    console.log("[OneForOne Supervisor] Started");
  }

  // Default strategy: one-for-one, 3 restarts in 5 seconds
  // childSupervision() returns DEFAULT_CHILD_SUPERVISION

  handleCall(message: any): any {
    if (message.type === "spawn") {
      const child = this.spawn(WorkerActor, { args: [message.name] });
      return child;
    }
    if (message.type === "children") {
      return this.getChildren();
    }
    return null;
  }

  handleCast(message: any): void {}
}

// --- Supervisor with one-for-all strategy ---

class OneForAllSupervisor extends Actor {
  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "one-for-all",
      maxRestarts: 3,
      periodMs: 5000,
    };
  }

  init() {
    console.log("[OneForAll Supervisor] Started");
  }

  handleCall(message: any): any {
    if (message.type === "spawn") {
      const child = this.spawn(WorkerActor, { args: [message.name] });
      return child;
    }
    if (message.type === "children") {
      return this.getChildren();
    }
    return null;
  }

  handleCast(message: any): void {}
}

// --- Supervisor with rest-for-one strategy ---

class RestForOneSupervisor extends Actor {
  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "rest-for-one",
      maxRestarts: 3,
      periodMs: 5000,
    };
  }

  init() {
    console.log("[RestForOne Supervisor] Started");
  }

  handleCall(message: any): any {
    if (message.type === "spawn") {
      const child = this.spawn(WorkerActor, { args: [message.name] });
      return child;
    }
    if (message.type === "children") {
      return this.getChildren();
    }
    return null;
  }

  handleCast(message: any): void {}
}

// --- Supervisor with low restart limit ---

class LimitedSupervisor extends Actor {
  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "one-for-one",
      maxRestarts: 2, // Only allow 2 restarts
      periodMs: 5000,
    };
  }

  init() {
    console.log("[Limited Supervisor] Started (max 2 restarts)");
  }

  handleCall(message: any): any {
    if (message.type === "spawn") {
      const child = this.spawn(WorkerActor, { args: [message.name] });
      return child;
    }
    if (message.type === "children") {
      return this.getChildren();
    }
    return null;
  }

  handleCast(message: any): void {}
}



// --- Helper functions ---

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getChildCount(supervisor: ActorRef): Promise<number> {
  const children = await supervisor.call({ type: "children" });
  return children.length;
}

// --- Main ---

async function main() {
  console.log("=== Supervision Tree Example ===\n");

  // Setup
  const transport = new InMemoryTransport("node1");
  await transport.connect();
  const registry = new LocalRegistry();
  const cluster = new LocalCluster("node1");
  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClasses([
    WorkerActor,
    OneForOneSupervisor,
    OneForAllSupervisor,
    RestForOneSupervisor,
    LimitedSupervisor,
  ]);
  await system.start();

  try {
    // === Demo 1: One-for-One Strategy ===
    console.log("--- Demo 1: One-for-One Strategy ---");
    console.log("Only the crashed child is restarted.\n");

    const oneForOne = system.spawn(OneForOneSupervisor);

    const w1 = await oneForOne.call({ type: "spawn", name: "Worker-A" });
    const w2 = await oneForOne.call({ type: "spawn", name: "Worker-B" });
    const w3 = await oneForOne.call({ type: "spawn", name: "Worker-C" });

    // Do some work
    w1.cast({ type: "work" });
    w2.cast({ type: "work" });
    w3.cast({ type: "work" });
    await delay(100);

    console.log("\nCrashing Worker-B...");
    w2.cast({ type: "crash" });
    await delay(200);

    console.log(`\nChild count after crash: ${await getChildCount(oneForOne)}`);
    console.log("(Only Worker-B was restarted, A and C kept their state)\n");

    // === Demo 2: One-for-All Strategy ===
    console.log("\n--- Demo 2: One-for-All Strategy ---");
    console.log("All children restart when one crashes.\n");

    const oneForAll = system.spawn(OneForAllSupervisor);

    const a1 = await oneForAll.call({ type: "spawn", name: "Alpha" });
    const a2 = await oneForAll.call({ type: "spawn", name: "Beta" });
    const a3 = await oneForAll.call({ type: "spawn", name: "Gamma" });

    // Do some work
    a1.cast({ type: "work" });
    a2.cast({ type: "work" });
    a3.cast({ type: "work" });
    await delay(100);

    console.log("\nCrashing Beta...");
    a2.cast({ type: "crash" });
    await delay(200);

    console.log(`\nChild count after crash: ${await getChildCount(oneForAll)}`);
    console.log(
      "(All workers were restarted - Alpha, Beta, Gamma all lost their state)\n",
    );

    // === Demo 3: Rest-for-One Strategy ===
    console.log("\n--- Demo 3: Rest-for-One Strategy ---");
    console.log("Crashed child and all children after it are restarted.\n");

    const restForOne = system.spawn(RestForOneSupervisor);

    const r1 = await restForOne.call({ type: "spawn", name: "First" });
    const r2 = await restForOne.call({ type: "spawn", name: "Second" });
    const r3 = await restForOne.call({ type: "spawn", name: "Third" });

    // Do some work
    r1.cast({ type: "work" });
    r2.cast({ type: "work" });
    r3.cast({ type: "work" });
    await delay(100);

    console.log("\nCrashing Second (middle child)...");
    r2.cast({ type: "crash" });
    await delay(200);

    console.log(
      `\nChild count after crash: ${await getChildCount(restForOne)}`,
    );
    console.log("(Second and Third were restarted, First kept its state)\n");

    // === Demo 4: Max Restart Limit ===
    console.log("\n--- Demo 4: Max Restart Limit ---");
    console.log("Child is stopped after exceeding restart limit.\n");

    const limited = system.spawn(LimitedSupervisor);
    await limited.call({ type: "spawn", name: "Unstable" });

    const crashChild = async () => {
      const children = await limited.call({ type: "children" });
      if (children.length > 0) {
        children[0].cast({ type: "crash" });
      }
    };

    console.log("Crash #1:");
    await crashChild();
    await delay(200);
    console.log(`  Children remaining: ${await getChildCount(limited)}`);

    console.log("\nCrash #2:");
    await crashChild();
    await delay(200);
    console.log(`  Children remaining: ${await getChildCount(limited)}`);

    console.log("\nCrash #3 (exceeds limit):");
    await crashChild();
    await delay(200);
    console.log(`  Children remaining: ${await getChildCount(limited)}`);
    console.log(
      "(Child was stopped permanently after exceeding 2 restart limit)\n",
    );
  } finally {
    // Cleanup
    await system.shutdown();
    await transport.disconnect();
  }

  console.log("=== Done ===");
}

main().catch(console.error);
