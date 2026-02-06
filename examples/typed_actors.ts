// examples/typed_actors.ts
//
// Demonstrates: Type-safe actors with compile-time message checking
// Prerequisites: None
// Run: npx ts-node examples/typed_actors.ts
//
// This example shows:
// - Defining typed message protocols for actors
// - Type-safe cast (fire-and-forget) messages
// - Type-safe call (request-reply) messages with typed responses
// - Discriminated unions for message handling

import {
  Actor,
  ActorRef,
  ActorSystem,
  LocalCluster,
  LocalRegistry,
  InMemoryTransport,
} from "../src";

// --- Message Type Definitions ---

// Cast messages for the Counter actor (fire-and-forget)
type CounterCast =
  | { type: "increment" }
  | { type: "decrement" }
  | { type: "add"; amount: number }
  | { type: "reset" };

// Call messages for the Counter actor (request-reply)
type CounterCall = { type: "get" } | { type: "getAndReset" };

// Reply type for Counter call messages
type CounterReply = number;

// --- Typed Actor Definition ---

/**
 * A type-safe counter actor.
 *
 * The type parameters ensure that:
 * - Only valid CounterCast messages can be sent via cast()
 * - Only valid CounterCall messages can be sent via call()
 * - call() returns the correct CounterReply type
 */
class CounterActor extends Actor<CounterCast, CounterCall, CounterReply> {
  private count = 0;
  private name: string = "Counter";

  init(name?: string) {
    if (name) this.name = name;
    console.log(`[${this.name}] Initialized with count = ${this.count}`);
  }

  handleCast(message: CounterCast): void {
    // TypeScript knows message is one of the CounterCast types
    switch (message.type) {
      case "increment":
        this.count++;
        console.log(`[${this.name}] Incremented to ${this.count}`);
        break;
      case "decrement":
        this.count--;
        console.log(`[${this.name}] Decremented to ${this.count}`);
        break;
      case "add":
        // TypeScript knows message.amount exists here
        this.count += message.amount;
        console.log(
          `[${this.name}] Added ${message.amount}, now ${this.count}`,
        );
        break;
      case "reset":
        this.count = 0;
        console.log(`[${this.name}] Reset to ${this.count}`);
        break;
    }
  }

  handleCall(message: CounterCall): CounterReply {
    // TypeScript knows message is one of the CounterCall types
    switch (message.type) {
      case "get":
        console.log(`[${this.name}] Get request, returning ${this.count}`);
        return this.count;
      case "getAndReset":
        const value = this.count;
        this.count = 0;
        console.log(`[${this.name}] GetAndReset, returning ${value}`);
        return value;
    }
  }
}

// --- Calculator Actor (demonstrates more complex types) ---

type CalculatorCast = { type: "clear" } | { type: "setMemory"; value: number };

type CalculatorCall =
  | { type: "add"; a: number; b: number }
  | { type: "multiply"; a: number; b: number }
  | { type: "divide"; a: number; b: number }
  | { type: "getMemory" };

// Reply can be different types based on the operation
type CalculatorReply = number | { error: string };

class CalculatorActor extends Actor<
  CalculatorCast,
  CalculatorCall,
  CalculatorReply
> {
  private memory = 0;

  init() {
    console.log("[Calculator] Ready for calculations");
  }

  handleCast(message: CalculatorCast): void {
    switch (message.type) {
      case "clear":
        this.memory = 0;
        console.log("[Calculator] Memory cleared");
        break;
      case "setMemory":
        this.memory = message.value;
        console.log(`[Calculator] Memory set to ${this.memory}`);
        break;
    }
  }

  handleCall(message: CalculatorCall): CalculatorReply {
    switch (message.type) {
      case "add":
        const sum = message.a + message.b;
        console.log(`[Calculator] ${message.a} + ${message.b} = ${sum}`);
        return sum;
      case "multiply":
        const product = message.a * message.b;
        console.log(`[Calculator] ${message.a} * ${message.b} = ${product}`);
        return product;
      case "divide":
        if (message.b === 0) {
          console.log("[Calculator] Error: Division by zero");
          return { error: "Division by zero" };
        }
        const quotient = message.a / message.b;
        console.log(`[Calculator] ${message.a} / ${message.b} = ${quotient}`);
        return quotient;
      case "getMemory":
        console.log(`[Calculator] Memory = ${this.memory}`);
        return this.memory;
    }
  }
}



// --- Main ---

async function main() {
  console.log("=== Typed Actors Example ===\n");

  // Setup
  const transport = new InMemoryTransport("node1");
  await transport.connect();
  const registry = new LocalRegistry();
  const cluster = new LocalCluster("node1");
  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClasses([CounterActor, CalculatorActor]);
  await system.start();

  try {
    // --- Counter Actor Demo ---
    console.log("--- Counter Actor ---\n");

    // Spawn returns ActorRef (untyped by default for simplicity)
    // You can cast to typed ref if needed for stricter checking
    const counter = system.spawn(CounterActor, {
      args: ["MyCounter"],
    }) as ActorRef<CounterCast, CounterCall, CounterReply>;

    // These are all type-safe - try changing the message types to see errors
    counter.cast({ type: "increment" });
    counter.cast({ type: "increment" });
    counter.cast({ type: "add", amount: 10 });
    counter.cast({ type: "decrement" });

    // Small delay for cast messages to process
    await new Promise((r) => setTimeout(r, 100));

    // Call returns the typed reply
    const value: number = await counter.call({ type: "get" });
    console.log(`\nCounter value via call: ${value}\n`);

    counter.cast({ type: "add", amount: 5 });
    await new Promise((r) => setTimeout(r, 50));

    const resetValue: number = await counter.call({ type: "getAndReset" });
    console.log(`\nValue before reset: ${resetValue}`);

    const afterReset: number = await counter.call({ type: "get" });
    console.log(`Value after reset: ${afterReset}\n`);

    // --- Calculator Actor Demo ---
    console.log("--- Calculator Actor ---\n");

    const calc = system.spawn(CalculatorActor) as ActorRef<
      CalculatorCast,
      CalculatorCall,
      CalculatorReply
    >;

    // Type-safe calculations
    const sum = await calc.call({ type: "add", a: 5, b: 3 });
    console.log(`Result of add: ${JSON.stringify(sum)}`);

    const product = await calc.call({ type: "multiply", a: 4, b: 7 });
    console.log(`Result of multiply: ${JSON.stringify(product)}`);

    const quotient = await calc.call({ type: "divide", a: 10, b: 2 });
    console.log(`Result of divide: ${JSON.stringify(quotient)}`);

    // Division by zero returns error object
    const divByZero = await calc.call({ type: "divide", a: 5, b: 0 });
    console.log(`Result of divide by zero: ${JSON.stringify(divByZero)}`);

    // Memory operations
    calc.cast({ type: "setMemory", value: 42 });
    await new Promise((r) => setTimeout(r, 50));

    const memory = await calc.call({ type: "getMemory" });
    console.log(`Memory value: ${JSON.stringify(memory)}`);

    calc.cast({ type: "clear" });
    await new Promise((r) => setTimeout(r, 50));

    const clearedMemory = await calc.call({ type: "getMemory" });
    console.log(`Memory after clear: ${JSON.stringify(clearedMemory)}`);
  } finally {
    // Cleanup
    await system.shutdown();
    await transport.disconnect();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
