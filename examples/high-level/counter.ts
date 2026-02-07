// examples/high-level/counter.ts
//
// Demonstrates: Basic functional actor with closure-based state
// Run: npx tsx examples/high-level/counter.ts
//
// This example shows:
// - createSystem() for minimal system setup
// - createActor() with closure-based state
// - Chainable handler registration: self.call().cast()
// - Type-safe call (request-reply) and cast (fire-and-forget)

import { createSystem, createActor } from "../../src";

// --- Actor Definitions ---

const Counter = createActor((ctx, self, initialValue: number) => {
  let count = initialValue;

  self
    .call("get", () => count)
    .call("inc", (n: number = 1) => {
      count += n;
      return count;
    })
    .call("dec", (n: number = 1) => {
      count -= n;
      return count;
    })
    .call("getAndReset", () => {
      const value = count;
      count = initialValue;
      return value;
    })
    .cast("set", (value: number) => {
      count = value;
      console.log(`  [Counter] Set to ${count}`);
    })
    .cast("reset", () => {
      count = initialValue;
      console.log(`  [Counter] Reset to ${count}`);
    });
});

// --- Main ---

async function main() {
  console.log("=== Functional Counter ===\n");
  const system = createSystem();

  try {
    const counter = system.spawn(Counter, { args: [0] });

    // Call: request-reply
    console.log("--- Call operations (request-reply) ---\n");

    let value = await counter.call({ method: "get", args: [] });
    console.log(`  Initial value: ${value}`);

    value = await counter.call({ method: "inc", args: [1] });
    console.log(`  After inc(1): ${value}`);

    value = await counter.call({ method: "inc", args: [10] });
    console.log(`  After inc(10): ${value}`);

    value = await counter.call({ method: "dec", args: [3] });
    console.log(`  After dec(3): ${value}`);

    // Cast: fire-and-forget
    console.log("\n--- Cast operations (fire-and-forget) ---\n");

    counter.cast({ method: "set", args: [42] });
    await new Promise((r) => setTimeout(r, 50));

    value = await counter.call({ method: "get", args: [] });
    console.log(`  After set(42): ${value}`);

    counter.cast({ method: "reset", args: [] });
    await new Promise((r) => setTimeout(r, 50));

    value = await counter.call({ method: "get", args: [] });
    console.log(`  After reset: ${value}`);

    // GetAndReset
    console.log("\n--- GetAndReset ---\n");

    await counter.call({ method: "inc", args: [25] });
    const prev = await counter.call({ method: "getAndReset", args: [] });
    const curr = await counter.call({ method: "get", args: [] });
    console.log(`  Before reset: ${prev}, after reset: ${curr}`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
