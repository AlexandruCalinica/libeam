# libeam

An Erlang/OTP-inspired actor system for TypeScript. Build distributed, fault-tolerant applications with location-transparent actors, automatic supervision, and gossip-based cluster membership.

## Features

- **Functional API**: Simple, closure-based actor definitions with `createSystem` and `createActor` (Recommended)
- **Actor Model**: Lightweight actors with message-passing semantics (`call` for request/response, `cast` for fire-and-forget)
- **Location Transparency**: Actors communicate via `ActorRef` regardless of whether the target is local or remote
- **Supervision**: Automatic crash handling with configurable restart strategies
- **Distributed Clustering**: Gossip-based membership detection with automatic peer discovery
- **Placement Strategies**: Control where actors are spawned (`local`, `round-robin`)
- **Transport Abstraction**: Pluggable transport layer (in-memory for testing, ZeroMQ for production)

## Elixir/OTP Parity

libeam implements the core primitives from Elixir/OTP, adapted for the Node.js runtime.

### Implemented

| Feature | Elixir/OTP | libeam |
|---------|------------|--------|
| **Actor Model** |
| Spawn processes | `spawn/1`, `GenServer.start/2` | `system.spawn()` |
| Async messages | `send/2`, `GenServer.cast/2` | `ref.cast()` |
| Sync calls | `GenServer.call/2` | `ref.call()` |
| **GenServer Callbacks** |
| `init/1` | Yes | `init()` |
| `handle_call/3` | Yes | `handleCall()` |
| `handle_cast/2` | Yes | `handleCast()` |
| `handle_info/2` | Yes | `handleInfo()` |
| `handle_continue/2` | Yes | `handleContinue()` |
| `terminate/2` | Yes | `terminate()` |
| Idle timeout | `{:noreply, state, timeout}` | `setIdleTimeout()` |
| **Supervision** |
| Supervisors | `Supervisor` | `Supervisor`, `ChildSupervisor` |
| one-for-one | Yes | Yes |
| one-for-all | Yes | Yes |
| rest-for-one | Yes | Yes |
| Max restarts | Yes | Yes |
| **Process Features** |
| Links | `Process.link/1` | `link()` |
| Monitors | `Process.monitor/1` | `watch()` |
| Trap exit | `Process.flag(:trap_exit, true)` | `setTrapExit()` |
| Exit signals | `Process.exit/2` | `exit()` |
| Timers | `Process.send_after/3` | `sendAfter()`, `sendInterval()` |
| **Introspection** |
| List children | `Supervisor.which_children/1` | `getChildren()` |
| Count children | `Supervisor.count_children/1` | `countChildren()` |
| **Abstractions** |
| Agent | `Agent` | `Agent` |
| **Distribution** |
| Cluster membership | `:net_kernel` | `Cluster`, `GossipProtocol` |
| Remote messaging | Transparent | Via `Transport` |
| Registry | `Registry`, `:global` | `Registry`, `DistributedRegistry` |
| Actor migration | Manual process migration | `system.migrate()` |

### Not Implemented (Not Needed in Node.js)

| Feature | Reason |
|---------|--------|
| `Task.async/await` | Use native `Promise` / `async-await` |
| Selective receive | Not practical without BEAM VM |
| Hot code upgrades | Use rolling deploys |
| `Application` behaviour | Use standard Node.js entry points |
| ETS/DETS | Use `Map` or external stores (Redis, etc.) |

### Not Yet Implemented

All core OTP features have been implemented. See the feature table above for the full list.

## Installation

```bash
pnpm add libeam
```

## Quick Start

### Functional API (Recommended)

The functional API provides a simple, closure-based approach to defining actors:

```typescript
import { createSystem, createActor } from "libeam";

// Define an actor with closure-based state
const Counter = createActor((ctx, self, initialValue: number) => {
  let count = initialValue;

  return self
    .onCall("get", () => count)
    .onCall("increment", () => ++count)
    .onCast("set", (value: number) => { count = value; });
});

// Create a system (one line!)
const system = createSystem();

// Spawn and interact with typed refs
const counter = system.spawn(Counter, { args: [0] });

const value = await counter.call("get");     // 0 — fully typed!
await counter.call("increment");              // 1
counter.cast("set", 100);                     // fire-and-forget

await system.shutdown();
```

### Class-Based API

For full control, extend the `Actor` class directly:

```typescript
import { Actor, ActorRef } from "libeam";

class CounterActor extends Actor {
  private count = 0;

  init(initialValue: number = 0) {
    this.count = initialValue;
    console.log(`Counter initialized with ${this.count}`);
  }

  // Synchronous request/response
  handleCall(message: { type: string }): number {
    switch (message.type) {
      case "get":
        return this.count;
      case "increment":
        return ++this.count;
      default:
        throw new Error(`Unknown message: ${message.type}`);
    }
  }

  // Fire-and-forget messages
  handleCast(message: { type: string; value?: number }): void {
    if (message.type === "set" && message.value !== undefined) {
      this.count = message.value;
    }
  }
}
```

### Single-Node Setup (In-Memory)

For testing or single-process applications:

```typescript
import {
  ActorSystem,
  InMemoryTransport,
  LocalCluster,
  LocalRegistry,
} from "libeam";

async function main() {
  const cluster = new LocalCluster("node1");
  const transport = new InMemoryTransport("node1");
  const registry = new LocalRegistry();

  await transport.connect();

  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClass(CounterActor);
  await system.start();

  // Spawn an actor
  const counter = system.spawn(CounterActor, {
    name: "my-counter",
    args: [10], // Initial value
  });

  // Interact with the actor
  const value = await counter.call({ type: "get" });
  console.log(`Current value: ${value}`); // 10

  await counter.call({ type: "increment" });
  console.log(`After increment: ${await counter.call({ type: "get" })}`); // 11

  counter.cast({ type: "set", value: 100 });
}

main();
```

### Multi-Node Setup (Functional API)

For distributed applications across multiple processes/machines, `createSystem` handles all the wiring — ZeroMQ transport, gossip protocol, cluster membership, and registry sync:

```typescript
import { createSystem, createActor, ActorRegistry } from "libeam";

// Define actors
const Ping = createActor((ctx, self) => {
  return self.onCast("ping", async (n: number) => {
    console.log(`Ping received: ${n}`);
    const pong = await ctx.getActorByName("pong");
    if (pong) pong.cast("pong", n + 1);
  });
});

const Pong = createActor((ctx, self) => {
  return self.onCast("pong", async (n: number) => {
    console.log(`Pong received: ${n}`);
    const ping = await ctx.getActorByName("ping");
    if (ping) ping.cast("ping", n + 1);
  });
});

// Register actors for typed getActorByName — same codebase on all nodes
declare module "libeam" {
  interface ActorRegistry {
    ping: typeof Ping;
    pong: typeof Pong;
  }
}

// Node 1 — port convention: rpc=5000, pub=5001, gossip=5002
const system1 = await createSystem({
  type: "distributed",
  port: 5000,
  seedNodes: [],
  cookie: "my-cluster-secret",
});
const ping = system1.spawn(Ping, { name: "ping" });

// Node 2 — joins via node1's gossip port
const system2 = await createSystem({
  type: "distributed",
  port: 5010,
  seedNodes: ["127.0.0.1:5002"],
  cookie: "my-cluster-secret",
});
system2.spawn(Pong, { name: "pong" });

// Start the game — typed ref from spawn() supports clean syntax
ping.cast("ping", 0);
```

Run the full distributed example:

```bash
# Terminal 1
npx tsx examples/high-level/distributed.ts node1

# Terminal 2
npx tsx examples/high-level/distributed.ts node2
```

### Multi-Node Setup (Class-Based API)

For full control over transport, gossip, and cluster configuration:

<details>
<summary>Manual wiring example</summary>

```typescript
import {
  ActorSystem,
  ZeroMQTransport,
  GossipProtocol,
  GossipUDP,
  DistributedCluster,
  DistributedRegistry,
  RegistrySync,
} from "libeam";

async function startNode(config: {
  nodeId: string;
  rpcPort: number;
  pubPort: number;
  gossipPort: number;
  seedNodes: string[];
}) {
  const { nodeId, rpcPort, pubPort, gossipPort, seedNodes } = config;

  // 1. Setup transport (ZeroMQ)
  const transport = new ZeroMQTransport({
    nodeId,
    rpcPort,
    pubPort,
    bindAddress: "0.0.0.0",
  });
  await transport.connect();

  // 2. Setup gossip protocol for membership
  const gossipUDP = new GossipUDP(gossipPort);
  const gossipProtocol = new GossipProtocol(
    nodeId,
    `tcp://127.0.0.1:${rpcPort}`, // RPC address for peers
    `127.0.0.1:${gossipPort}`, // Gossip address
    gossipUDP,
    {
      gossipIntervalMs: 1000,
      cleanupIntervalMs: 2000,
      failureTimeoutMs: 5000,
      gossipFanout: 3,
      seedNodes,
    },
  );

  // 3. Setup cluster (wraps gossip protocol)
  const cluster = new DistributedCluster(gossipProtocol);
  await cluster.start();

  // 4. Setup registry sync for actor name resolution
  const registrySync = new RegistrySync(nodeId, transport, cluster);
  const registry = new DistributedRegistry(nodeId, registrySync);

  // 5. Wire cluster membership changes to transport
  cluster.on("member_join", (peerId: string) => {
    const peer = cluster.getPeerState(peerId);
    if (peer) {
      transport.updatePeers([[peerId, peer.address]]);
    }
  });

  // 6. Create actor system
  const system = new ActorSystem(cluster, transport, registry);
  system.registerActorClass(CounterActor);
  await system.start();

  return { system, cluster, transport };
}

// Node 1 (seed node)
const node1 = await startNode({
  nodeId: "node1",
  rpcPort: 5000,
  pubPort: 5001,
  gossipPort: 6000,
  seedNodes: [], // No seeds for first node
});

// Node 2 (joins via seed)
const node2 = await startNode({
  nodeId: "node2",
  rpcPort: 5010,
  pubPort: 5011,
  gossipPort: 6010,
  seedNodes: ["127.0.0.1:6000"], // Connect to node1's gossip port
});
```

</details>

## Functional API

The functional API is the recommended way to build applications with libeam. It provides better type safety, less boilerplate, and a more modern developer experience.

### createSystem

The `createSystem` factory simplifies system creation and configuration.

```typescript
import { createSystem } from "libeam";

// Local system (synchronous, zero config)
const system = createSystem();

// Local with options
const system = createSystem({ nodeId: "my-node" });

// Distributed (async, with ZeroMQ + Gossip)
const system = await createSystem({
  type: "distributed",
  port: 5000,
  seedNodes: ["127.0.0.1:6002"],
});
```

**System Interface:**

- `spawn(actorClass, options?)`: Spawn an actor and return a `TypedActorRef`
- `register(actorClass)`: Register an actor class for remote spawning
- `getActorByName(name)`: Look up a named actor (local or remote)
- `shutdown()`: Gracefully shut down the system and all actors
- `nodeId`: The unique ID of this node
- `transport`: Access to the underlying transport layer
- `cluster`: Access to the cluster membership interface
- `registry`: Access to the actor registry
- `system`: Escape hatch to the raw `ActorSystem` instance

### createActor

Define actors using a closure-based factory function.

```typescript
const MyActor = createActor((ctx, self, ...args) => {
  // Initialization logic here
  
  return self.onCall("ping", () => "pong");
});
```

The factory function receives:
- `ctx`: The actor context (spawn, watch, link, stash, etc.)
- `self`: The actor builder (register handlers, timers, etc.)
- `...args`: Arguments passed during `spawn`

**ActorContext (ctx) Methods:**
- `self`: Reference to this actor
- `parent`: Reference to the parent actor
- `spawn(actor, options?)`: Spawn a child actor
- `watch(ref)` / `unwatch(ref)`: Monitor other actors
- `link(ref)` / `unlink(ref)`: Bidirectional crash propagation
- `exit(reason?)`: Stop this actor (with optional reason)
- `setTrapExit(boolean)`: Enable/disable exit trapping
- `getActorByName(name)`: Look up a named actor (local or remote)
- `stash()` / `unstash()` / `unstashAll()` / `clearStash()`: Message stashing

**ActorBuilder (self) Methods:**
- `onCall(name, handler)`: Register a request-reply handler
- `onCast(name, handler)`: Register a fire-and-forget handler
- `onInfo(type, handler)`: Register a handler for system messages (`"down"`, `"exit"`, `"timeout"`, `"moved"`)
- `onTerminate(handler)`: Cleanup logic
- `onContinue(handler)`: Deferred initialization
- `sendAfter(msg, delay)` / `sendInterval(msg, interval)`: Timers
- `setIdleTimeout(ms)`: Configure idle timeout
- `migratable({ getState, setState })`: Enable actor migration
- `childSupervision(options)`: Configure supervision strategy for children

### TypedActorRef

When you spawn an actor created with `createActor`, you get a `TypedActorRef`. This provides full TypeScript autocompletion and type checking for `call` and `cast`.

```typescript
const counter = system.spawn(Counter, { args: [0] });

// TypeScript knows "get" and "increment" are valid calls
const value = await counter.call("get");
await counter.call("increment");

// TypeScript knows "set" is a valid cast and requires a number
counter.cast("set", 42);
```

### Type Inference

When you `return` the builder chain from a `createActor` factory, TypeScript automatically infers the handler types:

```typescript
// With return — full type inference
const Counter = createActor((ctx, self, initial: number) => {
  let count = initial;
  return self
    .onCall("get", () => count)
    .onCall("increment", () => ++count)
    .onCast("set", (v: number) => { count = v; });
});

const counter = system.spawn(Counter, { args: [0] });
counter.call("get");        // TypeScript knows this returns number
counter.cast("set", 42);    // TypeScript knows "set" expects a number
counter.call("typo");       // Type error! "typo" is not a valid method
```

Without `return`, the factory still works but handlers are untyped:

```typescript
// Without return — still works, but no type inference
const Untyped = createActor((ctx, self) => {
  self.onCall("get", () => 42);
});
```

**Timer methods** (`sendAfter`, `sendInterval`) return `TimerRef`, not the builder, so they must be called on a separate line before the `return`:

```typescript
const Heartbeat = createActor((ctx, self) => {
  self.sendInterval({ type: "tick" }, 1000);  // separate line (returns TimerRef)
  return self
    .onCast("tick", () => console.log("tick"))
    .onTerminate(() => console.log("stopped"));
});
```

### Module Augmentation (Typed `getActorByName`)

By default, `getActorByName` returns an untyped `ActorRef`. To get fully typed refs, augment the `ActorRegistry` interface:

```typescript
// types.d.ts (or any .ts file)
import "libeam";

declare module "libeam" {
  interface ActorRegistry {
    counter: typeof Counter;
    "chat-room": typeof ChatRoom;
  }
}
```

Now `getActorByName` returns typed refs when called with registered names:

```typescript
const counter = await system.getActorByName("counter");
if (counter) {
  const value = await counter.call("get");  // fully typed!
  counter.cast("set", 100);                 // fully typed!
}
```

**Utility types** for working with actor definitions:

- `ActorRefFrom<T>` — Extract `TypedActorRef` from an `ActorDefinition`
- `ExtractCalls<T>` — Extract call handler types from an `ActorDefinition`
- `ExtractCasts<T>` — Extract cast handler types from an `ActorDefinition`

```typescript
import { ActorRefFrom } from "libeam";

type CounterRef = ActorRefFrom<typeof Counter>;
// TypedActorRef<{ get: () => number; increment: () => number }, { set: (v: number) => void }>
```

### Feature Comparison

| Feature | Functional API | Class-Based API |
|---------|---------------|-----------------|
| State management | Closures | Class fields |
| Message handlers | `self.onCall()` / `self.onCast()` | `handleCall()` / `handleCast()` |
| Type safety | Automatic (TypedActorRef) | Manual typing |
| System setup | `createSystem()` | Manual wiring |
| Child supervision | `self.childSupervision()` | `childSupervision()` override |
| Deferred init | `self.onContinue()` | `handleContinue()` override |
| Message stashing | `ctx.stash()` / `ctx.unstashAll()` | `this.stash()` / `this.unstashAll()` |

## Class-Based API Reference

This section documents the low-level, class-based API. While the Functional API is recommended for most use cases, the class-based API provides full control and is used internally by the system.

### Actor

Base class for all actors.

```typescript
class MyActor extends Actor {
  // Called when actor starts. Receives spawn arguments.
  init(...args: any[]): void | Promise<void>;

  // Called when actor is stopped.
  terminate(): void | Promise<void>;

  // Handle synchronous requests (must return a value).
  handleCall(message: any): any | Promise<any>;

  // Handle asynchronous messages (fire-and-forget).
  handleCast(message: any): void | Promise<void>;

  // Reference to self for sending to other actors
  self: ActorRef;
}
```

### handleContinue

Called when `init()` returns `{ continue: data }` for deferred async initialization.

```typescript
class DatabaseActor extends Actor {
  private db!: DatabaseConnection;

  init() {
    // Return immediately, continue async work
    return { continue: "connect" };
  }

  async handleContinue(data: string) {
    if (data === "connect") {
      this.db = await connectToDatabase();
    }
  }
}
```

See `examples/high-level/handle_continue.ts` and `examples/low-level/handle_continue.ts` for more examples.

### Idle Timeout

Set a timeout that fires when the actor is idle (no messages received).

```typescript
class SessionActor extends Actor {
  init() {
    // Timeout after 30 seconds of inactivity
    this.setIdleTimeout(30000);
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "timeout") {
      console.log(`Session idle for ${message.idleMs}ms, closing...`);
      this.exit(this.self, "normal");
    }
  }
}
```

**Methods:**

- `setIdleTimeout(timeoutMs: number): void` - Set idle timeout in milliseconds
- `getIdleTimeout(): number` - Get current idle timeout

The actor receives a `TimeoutMessage` via `handleInfo()` when the timeout fires.

See `examples/high-level/idle_timeout.ts` and `test/idle_timeout.test.ts` for more examples.

### Timers

Schedule delayed and periodic messages to yourself.

```typescript
class ReminderActor extends Actor {
  private reminderRef!: TimerRef;

  init() {
    // One-shot timer: remind after 5 seconds
    this.reminderRef = this.sendAfter({ type: "remind" }, 5000);
    
    // Periodic timer: tick every second
    this.sendInterval({ type: "tick" }, 1000);
  }

  handleCast(message: { type: string }) {
    if (message.type === "remind") {
      console.log("Time's up!");
    } else if (message.type === "tick") {
      console.log("Tick...");
    }
  }

  terminate() {
    // Clean up timers
    this.cancelTimer(this.reminderRef);
    this.cancelAllTimers();
  }
}
```

**Methods:**

- `sendAfter(message, delayMs): TimerRef` - Schedule one-shot message
- `sendInterval(message, intervalMs): TimerRef` - Schedule repeating message
- `cancelTimer(timerRef): boolean` - Cancel a specific timer
- `cancelAllTimers(): void` - Cancel all active timers

See `examples/high-level/timers.ts` and `examples/low-level/timers.ts` for more examples.

### Watching

Monitor another actor's lifecycle and receive notification when it terminates.

```typescript
class WorkerSupervisor extends Actor {
  private workerWatch!: WatchRef;

  init(workerRef: ActorRef) {
    // Start watching the worker
    this.workerWatch = this.watch(workerRef);
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "down") {
      const down = message as DownMessage;
      console.log(`Worker ${down.actorRef.id} terminated: ${down.reason.type}`);
      
      // Unwatch when done
      this.unwatch(down.watchRef);
    }
  }
}
```

**Methods:**

- `watch(actorRef): WatchRef` - Start watching an actor
- `unwatch(watchRef): void` - Stop watching

**Behavior:**
- One-shot notification: You receive exactly one `DownMessage` when the watched actor terminates
- Auto-cleanup: The watch is automatically removed after the DOWN message is delivered
- Works across nodes: Can watch actors on remote nodes

See `examples/high-level/watching.ts` and `examples/low-level/actor_watching.ts` for more examples.

### Links

Bidirectional crash propagation between actors. If one linked actor crashes, the other crashes too (unless trapExit is enabled).

```typescript
class ParentActor extends Actor {
  private childLink!: LinkRef;

  init(childRef: ActorRef) {
    // Link to child - bidirectional crash propagation
    this.childLink = this.link(childRef);
    
    // Enable trap exit to receive ExitMessage instead of crashing
    this.setTrapExit(true);
  }

  handleInfo(message: InfoMessage) {
    if (message.type === "exit") {
      const exit = message as ExitMessage;
      console.log(`Linked actor exited: ${exit.reason.type}`);
      
      // Unlink when done
      this.unlink(exit.linkRef!);
    }
  }

  terminateChild() {
    // Send exit signal to linked actor
    this.exit(this.childLink.actorRef, "shutdown");
  }
}
```

**Methods:**

- `link(actorRef): LinkRef` - Create bidirectional link
- `unlink(linkRef): void` - Remove link
- `setTrapExit(trap: boolean): void` - Enable/disable exit trapping
- `isTrapExit(): boolean` - Check if exit trapping is enabled
- `exit(actorRef, reason?): void` - Send exit signal to actor

**Exit Reasons:**
- `"normal"` - No effect on linked actors
- `"kill"` - Always terminates, ignores trapExit
- Custom string - Delivered to linked actors with trapExit enabled

See `examples/high-level/links.ts` and `examples/low-level/actor_links.ts` for more examples.

### Message Stashing

Defer message processing until the actor is ready. Useful for state-dependent message handling.

```typescript
class StatefulActor extends Actor {
  private ready = false;
  private pendingMessages: any[] = [];

  init() {
    // Actor starts in "not ready" state
    this.ready = false;
  }

  async handleCall(message: any) {
    if (!this.ready) {
      // Stash message for later processing
      this.stash();
      return "stashed";
    }
    // Process message normally
    return this.processMessage(message);
  }

  setReady() {
    this.ready = true;
    // Replay all stashed messages
    this.unstashAll();
  }

  private processMessage(message: any) {
    return `Processed: ${message}`;
  }
}
```

**Methods:**

- `stash(): void` - Save current message to stash
- `unstash(): void` - Replay one stashed message (FIFO order)
- `unstashAll(): void` - Replay all stashed messages
- `clearStash(): void` - Discard all stashed messages

See `examples/high-level/message_stashing.ts` and `test/message_stashing.test.ts` for more examples.

### InfoMessage Types

System messages delivered via `handleInfo()`. Use type guards to distinguish between message variants.

```typescript
handleInfo(message: InfoMessage) {
  switch (message.type) {
    case "down":
      const down = message as DownMessage;
      console.log(`Actor ${down.actorRef.id} terminated: ${down.reason.type}`);
      break;
    case "exit":
      const exit = message as ExitMessage;
      console.log(`Linked actor exited: ${exit.reason.type}`);
      break;
    case "timeout":
      const timeout = message as TimeoutMessage;
      console.log(`Idle for ${timeout.idleMs}ms`);
      break;
    case "moved":
      const moved = message as MovedMessage;
      console.log(`Actor moved to ${moved.newNodeId}`);
      break;
  }
}
```

| Message | Type | Fields | Description |
|---------|------|--------|-------------|
| `DownMessage` | `"down"` | `watchRef`, `actorRef`, `reason` | Watched actor terminated |
| `ExitMessage` | `"exit"` | `linkRef?`, `actorRef`, `reason` | Linked actor exited (trapExit only) |
| `TimeoutMessage` | `"timeout"` | `idleMs` | Idle timeout fired |
| `MovedMessage` | `"moved"` | `watchRef?`, `linkRef?`, `actorRef`, `oldNodeId`, `newNodeId`, `newActorId` | Actor migrated to another node |

**TerminationReason:**
```typescript
type TerminationReason = 
  | { type: "normal" }
  | { type: "error"; error: any }
  | { type: "killed" };
```

### ActorRef

Location-transparent reference to an actor.

```typescript
// Request/response with timeout (default 5000ms)
const result = await actorRef.call(message, timeout?);

// Fire-and-forget
actorRef.cast(message);
```

### Agent

State management abstraction for simple key-value storage.

```typescript
// Create an agent
const counter = Agent.start(system, 0);

// Read state
const value = await counter.get();

// Update state (waits for completion)
await counter.update(n => n + 1);

// Fire-and-forget update
counter.cast(n => n + 1);

// Stop the agent
await counter.stop();
```

**Methods:**

- `Agent.start<T>(system, initialState, options?): Agent<T>` - Create an agent
- `get(timeout?): Promise<T>` - Get current state
- `update(fn, timeout?): Promise<T>` - Update state, returns new value
- `getAndUpdate(fn, timeout?): Promise<T>` - Update state, returns old value
- `cast(fn): void` - Fire-and-forget state update
- `stop(): Promise<void>` - Stop the agent
- `getRef(): ActorRef` - Access underlying actor reference

See `test/agent.test.ts` for more examples.

### ActorSystem

Manages actor lifecycle on a node.

```typescript
const system = new ActorSystem(cluster, transport, registry, supervisionOptions?);

// Register actor classes for remote spawning
system.registerActorClass(MyActor);
system.registerActorClasses([ActorA, ActorB]);

// Spawn actors
const ref = system.spawn(MyActor, {
  name?: string,           // Optional registered name
  args?: any[],            // Arguments passed to init()
  strategy?: 'local' | 'round-robin'  // Placement strategy
});

// Stop an actor
await system.stop(actorRef);

// Start processing messages
await system.start();

// Check system state
system.isRunning();      // true if running and not shutting down
system.isShuttingDown(); // true if shutdown in progress

// Graceful shutdown
await system.shutdown({
  timeout: 5000,        // Max time to wait for actors (default: 5000ms)
  drainMailboxes: true  // Wait for pending messages (default: true)
});
```

### Supervision

Configure crash handling behavior:

```typescript
const system = new ActorSystem(cluster, transport, registry, {
  strategy: "Restart", // or 'Stop'
  maxRestarts: 3, // Max restarts within period
  periodMs: 5000, // Time window for restart counting
});
```

### Supervision Trees

Actors can spawn child actors, creating a supervision tree hierarchy. When a parent actor is stopped, all its children are automatically terminated first (cascading termination).

```typescript
class WorkerActor extends Actor {
  handleCall(message: any) {
    if (message.type === "work") {
      return `Processed: ${message.data}`;
    }
  }
  handleCast(message: any) {}
}

class SupervisorActor extends Actor {
  private workers: ActorRef[] = [];

  init(workerCount: number) {
    // Spawn child workers under this supervisor
    for (let i = 0; i < workerCount; i++) {
      const worker = this.spawn(WorkerActor, { name: `worker-${i}` });
      this.workers.push(worker);
    }
  }

  handleCall(message: any) {
    if (message.type === "get_worker_count") {
      return this.getChildren().length;
    }
    if (message.type === "dispatch") {
      // Round-robin to workers
      const worker = this.workers[message.index % this.workers.length];
      return worker.call({ type: "work", data: message.data });
    }
  }

  handleCast(message: any) {}
}

// Usage
const supervisor = system.spawn(SupervisorActor, { args: [3] });

// Supervisor has 3 child workers
const count = await supervisor.call({ type: "get_worker_count" }); // 3

// When supervisor is stopped, all workers are terminated first
await system.stop(supervisor); // Stops workers, then supervisor
```

#### Actor Context

Each actor has access to its context:

```typescript
class MyActor extends Actor {
  someMethod() {
    // Reference to parent actor (undefined for root actors)
    const parent = this.context.parent;

    // Set of child actor references
    const children = this.context.children;

    // Reference to the actor system
    const system = this.context.system;
  }
}
```

#### Child Management Methods

Actors have protected methods for managing children:

```typescript
class ParentActor extends Actor {
  handleCall(message: any) {
    if (message.type === "spawn_worker") {
      // Spawn a child actor
      const child = this.spawn(WorkerActor, {
        name: message.name,
        args: [message.config]
      });
      return child;
    }

    if (message.type === "stop_worker") {
      // Stop a specific child
      await this.stopChild(message.workerRef);
    }

    if (message.type === "list_workers") {
      // Get all children
      return this.getChildren();
    }
  }
}
```

#### Cascading Termination

When a parent is stopped:
1. All children are stopped recursively (depth-first)
2. Each child's `terminate()` is called
3. Children are removed from the system
4. Parent's `terminate()` is called last

```typescript
// Tree: root -> child1 -> grandchild
//            -> child2

await system.stop(rootRef);
// Termination order: grandchild, child1, child2, root
```

#### Child Supervision Strategies

Parent actors can define how their children should be supervised when they crash. Override the `childSupervision()` method to customize the behavior:

```typescript
import { Actor, ChildSupervisionOptions } from "libeam";

class MySupervisor extends Actor {
  // Override to customize child supervision
  childSupervision(): ChildSupervisionOptions {
    return {
      strategy: "one-for-all",  // or "one-for-one", "rest-for-one"
      maxRestarts: 3,           // Max restarts within period
      periodMs: 5000,           // Time window for restart counting
    };
  }

  init() {
    this.spawn(WorkerActor, { args: ["worker1"] });
    this.spawn(WorkerActor, { args: ["worker2"] });
    this.spawn(WorkerActor, { args: ["worker3"] });
  }

  handleCall(message: any) { return "ok"; }
  handleCast(message: any) {}
}
```

**Available Strategies:**

| Strategy | Behavior |
|----------|----------|
| `one-for-one` | Only restart the crashed child (default) |
| `one-for-all` | Restart all children if one crashes |
| `rest-for-one` | Restart the crashed child and all children spawned after it |

**one-for-one** (default): Isolates failures - only the crashed actor is restarted.

```typescript
// If worker2 crashes, only worker2 is restarted
// worker1 and worker3 are unaffected
```

**one-for-all**: Use when children have interdependencies and must be restarted together.

```typescript
// If any worker crashes, all workers are stopped and restarted
// Useful for tightly coupled processes (e.g., producer-consumer pairs)
```

**rest-for-one**: Use when children have ordered dependencies.

```typescript
// Children spawned in order: db -> cache -> api
// If cache crashes, cache and api are restarted (db is unaffected)
// If db crashes, all three are restarted
```

**Max Restarts:**

If a child exceeds `maxRestarts` within `periodMs`, it will be stopped permanently instead of restarted.

### Placement Strategies

Control where actors are spawned:

- `local`: Always spawn on the current node
- `round-robin`: Distribute across cluster members

```typescript
// Spawn locally
system.spawn(MyActor, { strategy: "local" });

// Distribute across nodes
system.spawn(MyActor, { strategy: "round-robin" });
```

### Cluster Interface

Implement for custom cluster membership:

```typescript
interface Cluster {
  readonly nodeId: string;
  getMembers(): string[];
}
```

### Transport Interface

Implement for custom network transport:

```typescript
interface Transport {
  getNodeId(): string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Point-to-point messaging
  request(nodeId: string, message: any, timeout: number): Promise<any>;
  send(nodeId: string, message: any): Promise<void>;

  // Pub/sub for registry propagation
  publish(topic: string, message: any): Promise<void>;
  subscribe(topic: string, handler: MessageHandler): Promise<Subscription>;

  // Message handlers
  onRequest(handler: RequestHandler): void;
  onMessage(handler: MessageHandler): void;

  // Peer management
  updatePeers(peers: Array<[nodeId: string, address: string]>): void;
}
```

## Example: Chat Application

A complete example showing actors communicating across nodes.

### Functional API (Recommended)

```typescript
import { createSystem, createActor, ActorRef } from "libeam";

const ChatRoom = createActor((ctx, self) => {
  const participants = new Map<string, ActorRef>();

  return self
    .onCall("getParticipants", () => Array.from(participants.keys()))
    .onCast("join", (name: string, ref: ActorRef) => {
      participants.set(name, ref);
      broadcast(`${name} joined the chat`);
    })
    .onCast("message", (from: string, text: string) => {
      broadcast(`[${from}] ${text}`);
    });

  function broadcast(text: string) {
    for (const ref of participants.values()) {
      ref.cast({ method: "notify", args: [text] });
    }
  }
});

const User = createActor((ctx, self, name: string, roomRef: ActorRef) => {
  // Join room on init (roomRef is untyped, so use raw message format)
  roomRef.cast({ method: "join", args: [name, ctx.self] });

  return self.onCast("notify", (text: string) => {
    console.log(`[${name}] ${text}`);
  });
});

// Usage:
const system = createSystem();
const room = system.spawn(ChatRoom);
system.spawn(User, { args: ["Alice", room] });
system.spawn(User, { args: ["Bob", room] });

// TypedActorRef — typed call/cast works directly on room
const members = await room.call("getParticipants"); // ["Alice", "Bob"]
```

### Class-Based API

```typescript
import {
  Actor,
  ActorRef,
  ActorSystem,
  InMemoryTransport,
  LocalRegistry,
  Cluster,
} from "libeam";

class ChatRoomActor extends Actor {
  private participants = new Map<string, ActorRef>();

  handleCast(
    message:
      | { type: "join"; name: string; ref: ActorRef }
      | { type: "message"; from: string; text: string },
  ) {
    if (message.type === "join") {
      this.participants.set(message.name, message.ref);
      this.broadcast(`${message.name} joined the chat`);
    } else if (message.type === "message") {
      this.broadcast(`[${message.from}] ${message.text}`);
    }
  }

  private broadcast(text: string) {
    for (const ref of this.participants.values()) {
      ref.cast({ type: "notification", text });
    }
  }
}

class UserActor extends Actor {
  private name = "";

  init(name: string, roomRef: ActorRef) {
    this.name = name;
    roomRef.cast({ type: "join", name, ref: this.self });
  }

  handleCast(message: { type: "notification"; text: string }) {
    console.log(`[${this.name}] ${message.text}`);
  }
}
```

Run the full example:

```bash
pnpm example:chat
```

## Graceful Shutdown

Proper shutdown ensures actors terminate cleanly and cluster peers are notified.

### Functional API (Recommended)

When using `createSystem`, a single call handles the entire shutdown sequence:

```typescript
const system = createSystem();
// ... spawn actors ...
await system.shutdown(); // Terminates actors, leaves cluster, disconnects transport
```

### Class-Based API

When manually wiring components, you must shut them down in order:

```typescript
async function shutdownNode(system, cluster, transport) {
  // 1. Shutdown actor system (terminates actors, unregisters names)
  await system.shutdown({
    timeout: 5000,        // Wait up to 5s for actors to terminate
    drainMailboxes: true  // Process pending messages first
  });

  // 2. Leave cluster gracefully (notifies peers)
  await cluster.leave();  // Broadcasts "leaving" status to peers

  // 3. Disconnect transport
  await transport.disconnect();
}

// Handle process signals
process.on("SIGTERM", () => shutdownNode(system, cluster, transport));
process.on("SIGINT", () => shutdownNode(system, cluster, transport));
```

### Shutdown Sequence

1. **ActorSystem.shutdown()**: Stops accepting new spawns, drains mailboxes, calls `terminate()` on all actors, unregisters named actors
2. **DistributedCluster.leave()**: Broadcasts "leaving" status to peers so they immediately remove this node from membership (instead of waiting for failure timeout)
3. **Transport.disconnect()**: Closes network connections

### Shutdown Options

```typescript
interface ShutdownOptions {
  timeout?: number;       // Max ms to wait for actors (default: 5000)
  drainMailboxes?: boolean; // Wait for pending messages (default: true)
}
```

## Authentication

Distributed systems can be secured with cookie-based authentication, inspired by Erlang's distribution cookie. When configured, nodes verify each other using HMAC-SHA256 signatures on gossip messages and challenge-response handshakes on transport connections.

### Cookie Configuration

```typescript
const system = await createSystem({
  type: "distributed",
  port: 5000,
  seedNodes: ["127.0.0.1:6002"],
  cookie: "my-cluster-secret",
});
```

All nodes in a cluster must share the same cookie. Nodes with different cookies cannot communicate — gossip messages are silently dropped and transport connections are rejected.

### Environment Variable

Instead of passing the cookie in code, set the `LIBEAM_COOKIE` environment variable:

```bash
LIBEAM_COOKIE=my-cluster-secret npx tsx app.ts
```

The precedence order is: `auth` option > `cookie` option > `LIBEAM_COOKIE` env var. If none are set, the system starts in open mode with a warning logged.

### Custom Authenticator

For advanced use cases, implement the `Authenticator` interface:

```typescript
import { Authenticator, CookieAuthenticator } from "libeam";

const system = await createSystem({
  type: "distributed",
  port: 5000,
  seedNodes: [],
  auth: new CookieAuthenticator("my-secret"),
});
```

The `Authenticator` interface covers both gossip (per-message HMAC signing) and transport (challenge-response handshake). See `src/auth.ts` for the full interface.

### Known Limitations

| Limitation | Details |
|------------|---------|
| PUB/SUB not authenticated | Registry sync messages are not signed in v1. Use network-level isolation (VPN/firewall) for defense in depth. |
| Cookie rotation requires restart | All nodes must restart to change the cookie. No hot-swap mechanism. |
| Authentication only, no encryption | HMAC proves identity but does not encrypt message payloads. |

## Logging

Libeam includes a structured logging system with configurable log levels and handlers.

### Configuration

```typescript
import { loggerConfig } from "libeam";

// Set log level (debug, info, warn, error, none)
loggerConfig.level = "debug";

// Custom log handler
loggerConfig.handler = (entry) => {
  // entry: { level, message, context, timestamp, error? }
  console.log(JSON.stringify(entry));
};
```

### Log Levels

- `debug`: Detailed debugging information
- `info`: General operational messages
- `warn`: Warning conditions
- `error`: Error conditions
- `none`: Disable all logging

### Component Loggers

Each component creates its own logger with context:

```typescript
import { createLogger } from "libeam";

const log = createLogger("MyComponent", nodeId);
log.info("Operation completed", { duration: 100 });
log.error("Operation failed", error, { operationId: "123" });
```

## Error Handling

Libeam provides typed error classes for better error handling:

```typescript
import {
  LibeamError,
  ActorNotFoundError,
  RegistryLookupError,
  TimeoutError,
  SystemShuttingDownError,
  TransportError,
  PeerNotFoundError,
} from "libeam";

try {
  await actorRef.call({ type: "get" });
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(`Timed out after ${err.context?.timeoutMs}ms`);
  } else if (err instanceof ActorNotFoundError) {
    console.log(`Actor ${err.context?.actorId} not found`);
  }
}
```

### Error Types

| Error | Code | Description |
|-------|------|-------------|
| `ActorNotFoundError` | `ACTOR_NOT_FOUND` | Actor does not exist |
| `RegistryLookupError` | `REGISTRY_LOOKUP_FAILED` | Named actor not in registry |
| `TimeoutError` | `TIMEOUT` | Operation timed out |
| `SystemShuttingDownError` | `SYSTEM_SHUTTING_DOWN` | System is shutting down |
| `TransportError` | `TRANSPORT_ERROR` | Network transport failure |
| `PeerNotFoundError` | `PEER_NOT_FOUND` | Peer node not known |
| `ActorClassNotRegisteredError` | `ACTOR_CLASS_NOT_REGISTERED` | Actor class not registered for remote spawn |
| `AuthenticationError` | `AUTHENTICATION_FAILED` | Node authentication failed |
| `ActorNotMigratableError` | `ACTOR_NOT_MIGRATABLE` | Actor doesn't implement `Migratable` |
| `ActorHasChildrenError` | `ACTOR_HAS_CHILDREN` | Actor has child actors |

## Health Checks

Libeam provides health check support for monitoring system status, useful for Kubernetes probes and monitoring systems.

### Component Health

Both `ActorSystem` and `DistributedCluster` implement `HealthCheckable`:

```typescript
import { ActorSystem, DistributedCluster } from "libeam";

// Get health from individual components
const systemHealth = system.getHealth();
// {
//   name: "ActorSystem",
//   status: "healthy",
//   message: "System is healthy",
//   details: { actorCount: 5, totalMailboxSize: 0, registeredClasses: 3 }
// }

const clusterHealth = cluster.getHealth();
// {
//   name: "Cluster",
//   status: "healthy",
//   message: "Connected to 2 peer(s)",
//   details: { peerCount: 3, peers: ["node1", "node2", "node3"] }
// }
```

### Health Aggregator

Use `HealthAggregator` to combine health from multiple components:

```typescript
import { HealthAggregator } from "libeam";

const health = new HealthAggregator(nodeId);
health.register("actorSystem", system);
health.register("cluster", cluster);

// Full health report
const report = await health.getHealth();
// {
//   status: "healthy",
//   timestamp: Date,
//   nodeId: "node1",
//   uptimeMs: 123456,
//   components: [...]
// }

// For Kubernetes probes
app.get("/health/live", (req, res) => {
  res.status(health.isAlive() ? 200 : 503).send();
});

app.get("/health/ready", async (req, res) => {
  const ready = await health.isReady();
  res.status(ready ? 200 : 503).send();
});

app.get("/health", async (req, res) => {
  const report = await health.getHealth();
  res.status(report.status === "unhealthy" ? 503 : 200).json(report);
});
```

### Health Status

| Status | Description |
|--------|-------------|
| `healthy` | Component is functioning normally |
| `degraded` | Component is working but with issues (e.g., shutting down, high load) |
| `unhealthy` | Component is not functioning |

## Actor Migration

Actors can be migrated between nodes while preserving their state and pending messages.

### Making Actors Migratable

Implement the `Migratable` interface to enable migration:

```typescript
import { Actor, Migratable } from "libeam";

interface CounterState {
  count: number;
  history: string[];
}

class CounterActor extends Actor implements Migratable {
  private count = 0;
  private history: string[] = [];

  handleCall(message: any): number {
    if (message.type === "get") return this.count;
    if (message.type === "increment") return ++this.count;
    return 0;
  }

  handleCast(message: any): void {
    if (message.type === "reset") this.count = 0;
  }

  getState(): CounterState {
    return { count: this.count, history: [...this.history] };
  }

  setState(state: CounterState): void {
    this.count = state.count;
    this.history = [...state.history];
  }
}
```

### Migrating an Actor

Use `system.migrate()` to move an actor to another node:

```typescript
const ref = system.spawn(CounterActor, { name: "my-counter", args: [100] });

ref.cast({ type: "increment" });
ref.cast({ type: "increment" });

const result = await system.migrate("my-counter", "node2");

if (result.success) {
  console.log(`Migrated to ${result.newNodeId}`);
  console.log(`New actor ID: ${result.newActorId}`);
} else {
  console.log(`Migration failed: ${result.error}`);
}
```

### Migration Process

1. **Pause mailbox** - Stop processing new messages on source node
2. **Reserve name** - Target node reserves the actor name (with TTL)
3. **Drain mailbox** - Collect pending messages
4. **Serialize state** - Call `getState()` on source actor
5. **Transfer** - Send state and pending messages to target
6. **Restore** - Create actor on target, call `init()` then `setState()`
7. **Inject messages** - Re-queue pending messages on target
8. **Notify watchers** - Send `MovedMessage` to all watchers/linked actors
9. **Cleanup** - Remove actor from source node

### Watcher Notifications

Actors watching a migrating actor receive a `MovedMessage`:

```typescript
class ObserverActor extends Actor {
  handleInfo(message: InfoMessage): void {
    if (message.type === "moved") {
      const moved = message as MovedMessage;
      console.log(`Actor moved: ${moved.oldNodeId} → ${moved.newNodeId}`);
      console.log(`New actor ID: ${moved.newActorId}`);
    }
  }
}
```

### Constraints

| Constraint | Reason |
|------------|--------|
| Actor must implement `Migratable` | State serialization required |
| Actor cannot have children | Child actors would be orphaned |
| State must be JSON-serializable | Transferred over network |
| Target node must have actor class registered | Cannot instantiate unknown class |

### Error Types

| Error | Code | Description |
|-------|------|-------------|
| `ActorNotMigratableError` | `ACTOR_NOT_MIGRATABLE` | Actor doesn't implement `Migratable` |
| `ActorHasChildrenError` | `ACTOR_HAS_CHILDREN` | Actor has child actors |
| `MigrationFailedError` | `MIGRATION_FAILED` | General migration failure |
| `NameReservationError` | `NAME_RESERVATION_FAILED` | Could not reserve name on target |

Run the migration example:

```bash
npx ts-node examples/low-level/actor_migration.ts
```

## Architecture

```
Node Instance:
├── DistributedCluster (membership via UDP gossip)
│   └── GossipProtocol → GossipUDP
├── Transport (ZeroMQ or InMemory)
│   ├── ROUTER socket (RPC requests)
│   ├── PUB socket (registry broadcasts)
│   ├── SUB socket (registry subscriptions)
│   └── DEALER pool (outgoing RPC)
├── RegistrySync (actor name → nodeId mapping)
│   └── VectorClock (conflict resolution)
└── ActorSystem
    ├── Supervisor (crash handling)
    └── PlacementEngine (actor placement)
```

## Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Type check
pnpm typecheck
```

## License

ISC
