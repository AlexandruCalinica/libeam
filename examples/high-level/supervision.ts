// examples/high-level/supervision.ts
//
// Demonstrates: Child supervision strategies (one-for-one, one-for-all)
// Run: npx tsx examples/high-level/supervision.ts

import { createSystem, createActor, ActorRef } from "../../src";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Worker = createActor((ctx, self, name: string) => {
  let workCount = 0;
  console.log(`  [${name}] Started (new instance)`);

  self
    .call("status", () => ({ name, workCount }))
    .cast("work", () => {
      workCount++;
      console.log(`  [${name}] Did work #${workCount}`);
    })
    .cast("crash", () => {
      console.log(`  [${name}] Crashing!`);
      throw new Error(`${name} crashed`);
    })
    .onTerminate(() => console.log(`  [${name}] Terminated`));
});

const OneForOneSupervisor = createActor((ctx, self) => {
  console.log("[OneForOne Supervisor] Started");
  self.childSupervision({
    strategy: "one-for-one",
    maxRestarts: 3,
    periodMs: 5000,
  });
  self.call("spawn", (name: string) => ctx.spawn(Worker, { args: [name] }));
});

const OneForAllSupervisor = createActor((ctx, self) => {
  console.log("[OneForAll Supervisor] Started");
  self.childSupervision({
    strategy: "one-for-all",
    maxRestarts: 3,
    periodMs: 5000,
  });
  self.call("spawn", (name: string) => ctx.spawn(Worker, { args: [name] }));
});

async function main() {
  console.log("=== Supervision Example ===\n");
  const system = createSystem();

  try {
    console.log("--- Demo 1: One-for-One Strategy ---");
    console.log("Only the crashed child is restarted.\n");

    const sup1 = system.spawn(OneForOneSupervisor, {});
    const w1: ActorRef = await sup1.call({ method: "spawn", args: ["Worker-A"] });
    const w2: ActorRef = await sup1.call({ method: "spawn", args: ["Worker-B"] });
    const w3: ActorRef = await sup1.call({ method: "spawn", args: ["Worker-C"] });

    w1.cast({ method: "work", args: [] });
    w2.cast({ method: "work", args: [] });
    w3.cast({ method: "work", args: [] });
    await delay(100);

    console.log("\nCrashing Worker-B...");
    w2.cast({ method: "crash", args: [] });
    await delay(200);

    const statusA = await w1.call({ method: "status", args: [] });
    console.log(`Worker-A status: workCount=${statusA.workCount} (preserved)`);
    console.log("(Only Worker-B was restarted, A and C kept their state)\n");

    console.log("\n--- Demo 2: One-for-All Strategy ---");
    console.log("All children restart when one crashes.\n");

    const sup2 = system.spawn(OneForAllSupervisor, {});
    const a1: ActorRef = await sup2.call({ method: "spawn", args: ["Alpha"] });
    const a2: ActorRef = await sup2.call({ method: "spawn", args: ["Beta"] });
    const a3: ActorRef = await sup2.call({ method: "spawn", args: ["Gamma"] });

    a1.cast({ method: "work", args: [] });
    a2.cast({ method: "work", args: [] });
    a3.cast({ method: "work", args: [] });
    await delay(100);

    console.log("\nCrashing Beta...");
    a2.cast({ method: "crash", args: [] });
    await delay(200);
    console.log("(All workers restarted — Alpha, Beta, Gamma all lost state)\n");

    console.log("\n--- Demo 3: Max Restart Limit ---");
    console.log("Child stopped permanently after exceeding restart limit.\n");

    const LimitedSupervisor = createActor((ctx, self) => {
      console.log("[Limited Supervisor] Started (max 2 restarts)");
      self.childSupervision({
        strategy: "one-for-one",
        maxRestarts: 2,
        periodMs: 5000,
      });
      self.call("spawn", (name: string) => ctx.spawn(Worker, { args: [name] }));
    });

    const sup3 = system.spawn(LimitedSupervisor, {});
    const child: ActorRef = await sup3.call({ method: "spawn", args: ["Unstable"] });

    for (let i = 1; i <= 3; i++) {
      console.log(`Crash #${i}:`);
      child.cast({ method: "crash", args: [] });
      await delay(200);
    }
    console.log("(Child stopped permanently after exceeding 2 restart limit)\n");
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
