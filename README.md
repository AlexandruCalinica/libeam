# libeam

An Erlang/OTP-inspired actor system for TypeScript. Build distributed, fault-tolerant applications with location-transparent actors, automatic supervision, and gossip-based cluster membership.

## Features

- **Actor Model**: Lightweight actors with message-passing semantics (`call` for request/response, `cast` for fire-and-forget)
- **Location Transparency**: Actors communicate via `ActorRef` regardless of whether the target is local or remote
- **Supervision**: Automatic crash handling with configurable restart strategies
- **Distributed Clustering**: Gossip-based membership detection with automatic peer discovery
- **Placement Strategies**: Control where actors are spawned (`local`, `round-robin`)
- **Transport Abstraction**: Pluggable transport layer (in-memory for testing, ZeroMQ for production)

## Installation

```bash
pnpm add libeam
```

## Quick Start

### Defining Actors

Extend the `Actor` class and implement message handlers:

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
  InMemoryRegistry,
  Cluster,
} from "libeam";

// Simple cluster implementation for single node
class SingleNodeCluster implements Cluster {
  constructor(public readonly nodeId: string) {}
  getMembers(): string[] {
    return [this.nodeId];
  }
}

async function main() {
  const cluster = new SingleNodeCluster("node1");
  const transport = new InMemoryTransport("node1");
  const registry = new InMemoryRegistry();

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

### Multi-Node Setup (ZeroMQ + Gossip)

For distributed applications across multiple processes/machines:

```typescript
import {
  ActorSystem,
  ZeroMQTransport,
  GossipProtocol,
  GossipUDP,
  CustomGossipCluster,
  GossipRegistry,
  RegistryGossip,
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
  const cluster = new CustomGossipCluster(gossipProtocol);
  await cluster.start();

  // 4. Setup registry gossip for actor name resolution
  const registryGossip = new RegistryGossip(nodeId, transport);
  const registry = new GossipRegistry(nodeId, registryGossip);

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

## API Reference

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

### ActorRef

Location-transparent reference to an actor.

```typescript
// Request/response with timeout (default 5000ms)
const result = await actorRef.call(message, timeout?);

// Fire-and-forget
actorRef.cast(message);
```

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

A complete example showing actors communicating across nodes:

```typescript
import {
  Actor,
  ActorRef,
  ActorSystem,
  InMemoryTransport,
  InMemoryRegistry,
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

Proper shutdown ensures actors terminate cleanly and cluster peers are notified:

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
2. **CustomGossipCluster.leave()**: Broadcasts "leaving" status to peers so they immediately remove this node from membership (instead of waiting for failure timeout)
3. **Transport.disconnect()**: Closes network connections

### Shutdown Options

```typescript
interface ShutdownOptions {
  timeout?: number;       // Max ms to wait for actors (default: 5000)
  drainMailboxes?: boolean; // Wait for pending messages (default: true)
}
```

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

## Health Checks

Libeam provides health check support for monitoring system status, useful for Kubernetes probes and monitoring systems.

### Component Health

Both `ActorSystem` and `CustomGossipCluster` implement `HealthCheckable`:

```typescript
import { ActorSystem, CustomGossipCluster } from "libeam";

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

## Architecture

```
Node Instance:
├── CustomGossipCluster (membership via UDP gossip)
│   └── GossipProtocol → GossipUDP
├── Transport (ZeroMQ or InMemory)
│   ├── ROUTER socket (RPC requests)
│   ├── PUB socket (registry broadcasts)
│   ├── SUB socket (registry subscriptions)
│   └── DEALER pool (outgoing RPC)
├── RegistryGossip (actor name → nodeId mapping)
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
