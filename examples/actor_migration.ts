// examples/actor_migration.ts
//
// Demonstrates: Actor migration between nodes
// Prerequisites: None (uses in-memory transport for simplicity)
// Run: npx ts-node examples/actor_migration.ts
//
// This example shows how to migrate actors from one node to another while
// preserving their state and pending messages.
//
// Key features demonstrated:
// 1. Migratable interface - Actors implement getState/setState for serialization
// 2. State preservation - Actor state is transferred to the new node
// 3. Pending message preservation - Messages are carried over during migration
// 4. Watcher/Link notifications - Observers receive MovedMessage on migration

import {
  Actor,
  ActorSystem,
  Cluster,
  InMemoryTransport,
  InMemoryRegistry,
  Migratable,
  InfoMessage,
  MovedMessage,
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
 * A stateful counter actor that implements Migratable.
 * This actor can be migrated between nodes while preserving its state.
 */
class CounterActor extends Actor implements Migratable {
  private count = 0;
  private history: string[] = [];

  init(initialCount: number = 0): void {
    this.count = initialCount;
    this.history.push(`Initialized with ${initialCount}`);
    console.log(
      `  [Counter] Started on ${this.self.id.systemId} with count=${initialCount}`,
    );
  }

  handleCast(message: any): void {
    if (message.type === "increment") {
      this.count++;
      this.history.push(`Incremented to ${this.count}`);
      console.log(`  [Counter] Incremented to ${this.count}`);
    } else if (message.type === "decrement") {
      this.count--;
      this.history.push(`Decremented to ${this.count}`);
      console.log(`  [Counter] Decremented to ${this.count}`);
    } else if (message.type === "add") {
      this.count += message.amount;
      this.history.push(`Added ${message.amount}, now ${this.count}`);
      console.log(`  [Counter] Added ${message.amount}, now ${this.count}`);
    }
  }

  handleCall(message: any): any {
    if (message.type === "get") {
      return this.count;
    }
    if (message.type === "getHistory") {
      return [...this.history];
    }
    return null;
  }

  // Migratable interface - serialize state
  getState(): { count: number; history: string[] } {
    console.log(`  [Counter] Serializing state for migration...`);
    return {
      count: this.count,
      history: [...this.history],
    };
  }

  // Migratable interface - restore state
  setState(state: { count: number; history: string[] }): void {
    this.count = state.count;
    this.history = [...state.history];
    this.history.push(`Migrated to ${this.self.id.systemId}`);
    console.log(
      `  [Counter] Restored state on ${this.self.id.systemId}, count=${this.count}`,
    );
  }
}

/**
 * An observer actor that watches other actors and receives notifications
 * when they migrate (MovedMessage) or terminate (DownMessage).
 */
class ObserverActor extends Actor {
  private notifications: string[] = [];

  init(): void {
    console.log(`  [Observer] Started on ${this.self.id.systemId}`);
  }

  handleCast(message: any): void {
    if (message.type === "watch") {
      this.watch(message.target);
      console.log(`  [Observer] Now watching actor`);
    }
  }

  handleCall(message: any): any {
    if (message.type === "getNotifications") {
      return [...this.notifications];
    }
    return null;
  }

  handleInfo(message: InfoMessage): void {
    if (message.type === "moved") {
      const moved = message as MovedMessage;
      const notification = `Actor moved from ${moved.oldNodeId} to ${moved.newNodeId}`;
      this.notifications.push(notification);
      console.log(`  [Observer] Received MovedMessage: ${notification}`);
      console.log(`  [Observer] New actor ID: ${moved.newActorId}`);
    } else if (message.type === "down") {
      this.notifications.push(`Actor terminated`);
      console.log(`  [Observer] Received DownMessage`);
    }
  }
}

// --- Helper Functions ---

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

async function main() {
  console.log("=== Actor Migration Example ===\n");

  // --- Setup two nodes ---

  const transport1 = new InMemoryTransport("node1");
  const transport2 = new InMemoryTransport("node2");

  // Connect transports so they can communicate
  transport1.setPeer("node2", transport2);
  transport2.setPeer("node1", transport1);

  await transport1.connect();
  await transport2.connect();

  const registry1 = new InMemoryRegistry();
  const registry2 = new InMemoryRegistry();

  const cluster1 = new MockCluster("node1");
  const cluster2 = new MockCluster("node2");

  const system1 = new ActorSystem(cluster1, transport1, registry1);
  const system2 = new ActorSystem(cluster2, transport2, registry2);

  // Both nodes must have the actor classes registered
  system1.registerActorClasses([CounterActor, ObserverActor]);
  system2.registerActorClasses([CounterActor, ObserverActor]);

  await system1.start();
  await system2.start();

  console.log("Two nodes started: node1 and node2\n");

  try {
    // --- Demo 1: Basic Migration with State Preservation ---

    console.log("--- Demo 1: Basic Migration with State Preservation ---\n");

    // Spawn a counter on node1
    const counterRef = system1.spawn(CounterActor, {
      name: "my-counter",
      args: [100], // Initial count
    });
    await sleep(10);

    // Modify state
    counterRef.cast({ type: "increment" });
    counterRef.cast({ type: "increment" });
    counterRef.cast({ type: "add", amount: 50 });
    await sleep(10);

    // Verify state before migration
    const countBefore = await counterRef.call({ type: "get" });
    console.log(`\nCount before migration: ${countBefore}`);

    const historyBefore = await counterRef.call({ type: "getHistory" });
    console.log(`History before migration: ${historyBefore.length} entries`);

    console.log("\nMigrating actor from node1 to node2...\n");
    const result = await system1.migrate("my-counter", "node2");

    if (result.success) {
      console.log(`\nMigration successful!`);
      console.log(`  New node: ${result.newNodeId}`);
      console.log(`  New actor ID: ${result.newActorId}`);

      // Get reference to migrated actor
      const newRef = system2.getRef({
        systemId: "node2",
        id: result.newActorId!,
        name: "my-counter",
      } as any);

      // Verify state was preserved
      const countAfter = await newRef.call({ type: "get" });
      console.log(`\nCount after migration: ${countAfter}`);

      const historyAfter = await newRef.call({ type: "getHistory" });
      console.log(`History after migration: ${historyAfter.length} entries`);
      console.log(`Latest history entry: "${historyAfter[historyAfter.length - 1]}"`);

      // Continue using the actor on new node
      newRef.cast({ type: "increment" });
      await sleep(10);
      const finalCount = await newRef.call({ type: "get" });
      console.log(`\nCount after post-migration increment: ${finalCount}`);
    } else {
      console.log(`Migration failed: ${result.error}`);
    }

    // --- Demo 2: Migration with Watcher Notification ---

    console.log("\n\n--- Demo 2: Migration with Watcher Notification ---\n");

    // Spawn a new counter on node1
    const counter2Ref = system1.spawn(CounterActor, {
      name: "watched-counter",
      args: [0],
    });
    await sleep(10);

    // Spawn an observer on node1 that watches the counter
    const observerRef = system1.spawn(ObserverActor, {
      name: "observer",
    });
    await sleep(10);

    // Set up watch
    observerRef.cast({ type: "watch", target: counter2Ref });
    await sleep(10);

    console.log("\nMigrating watched counter...\n");
    const result2 = await system1.migrate("watched-counter", "node2");
    await sleep(50); // Give time for notification

    if (result2.success) {
      console.log(`\nMigration successful!`);

      // Check observer received notification
      const notifications = await observerRef.call({ type: "getNotifications" });
      console.log(`\nObserver notifications: ${notifications.length}`);
      for (const n of notifications) {
        console.log(`  - ${n}`);
      }
    }

    // --- Demo 3: Non-Migratable Actor ---

    console.log("\n\n--- Demo 3: Non-Migratable Actor (Error Handling) ---\n");

    // ObserverActor doesn't implement Migratable
    system1.spawn(ObserverActor, { name: "non-migratable" });
    await sleep(10);

    try {
      await system1.migrate("non-migratable", "node2");
    } catch (err: any) {
      console.log(`Expected error: ${err.code}`);
      console.log(`Message: ${err.message}`);
    }

    console.log("\n=== Example Complete ===");
  } finally {
    // Cleanup
    await system1.shutdown();
    await system2.shutdown();
    await transport1.disconnect();
    await transport2.disconnect();
  }
}

main().catch(console.error);
