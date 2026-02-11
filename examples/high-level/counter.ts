// examples/high-level/counter.ts
//
// Demonstrates: Basic functional actor with closure-based state
// Run: npx tsx examples/high-level/counter.ts
//
// This example shows:
// - createSystem() for minimal system setup
// - createActor() with closure-based state
// - Chainable handler registration: self.onCall().onCast()
// - Type-safe call (request-reply) and cast (fire-and-forget)

import { createSystem, createActor } from "../../src";

// --- Actor Definitions ---

const Counter = createActor((ctx, self, initialValue: number) => {
  let count = initialValue;

  return self
    .onCall("get", () => count)
    .onCall("inc", (n: number = 1) => {
      count += n;
      return count;
    })
    .onCall("dec", (n: number = 1) => {
      count -= n;
      return count;
    })
    .onCall("getAndReset", () => {
      const value = count;
      count = initialValue;
      return value;
    })
    .onCast("set", (value: number) => {
      count = value;
      console.log(`  [Counter] Set to ${count}`);
    })
    .onCast("reset", () => {
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

    let value = await counter.call("get");
    console.log(`  Initial value: ${value}`);

    value = await counter.call("inc", 1);
    console.log(`  After inc(1): ${value}`);

    value = await counter.call("inc", 10);
    console.log(`  After inc(10): ${value}`);

    value = await counter.call("dec", 3);
    console.log(`  After dec(3): ${value}`);

    // Cast: fire-and-forget
    console.log("\n--- Cast operations (fire-and-forget) ---\n");

    counter.cast("set", 42);
    await new Promise((r) => setTimeout(r, 50));

    value = await counter.call("get");
    console.log(`  After set(42): ${value}`);

    counter.cast("reset");
    await new Promise((r) => setTimeout(r, 50));

    value = await counter.call("get");
    console.log(`  After reset: ${value}`);

    // GetAndReset
    console.log("\n--- GetAndReset ---\n");

    await counter.call("inc", 25);
    const prev = await counter.call("getAndReset");
    const curr = await counter.call("get");
    console.log(`  Before reset: ${prev}, after reset: ${curr}`);
  } finally {
    await system.shutdown();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
