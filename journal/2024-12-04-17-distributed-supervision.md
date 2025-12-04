# Entry 17: Distributed Supervision

## Project Timeline

- **Entry 1**: Decentralized registry with gossip protocol
- **Entry 2**: Cleanup and ZeroMQ transport testing
- **Entry 3**: Graceful shutdown implementation
- **Entry 4**: Structured logging and error handling
- **Entry 5**: Health checks for actor system components
- **Entry 6**: Basic supervision trees (parent-child)
- **Entry 7**: Child supervision strategies (one-for-one, one-for-all, rest-for-one)
- **Entry 8**: Actor watching (monitoring termination)
- **Entry 9**: Message stashing (deferred processing)
- **Entry 10**: Typed actors with generics
- **Entry 11**: Unified typed API
- **Entry 12**: Distributed actor refs via registry lookup
- **Entry 13**: Core OTP features - timers, handleContinue, links, idle timeout
- **Entry 14**: Distributed actor watching
- **Entry 15**: Distributed actor linking
- **Entry 16**: Plan - Distributed Supervision
- **Entry 17 (Current)**: Distributed Supervision

## Current State

### All Tests Passing

All 149 tests pass. All 13 examples run successfully including the new distributed supervision example.

### Features Complete

Distributed supervision is now fully implemented with:
- Remote child spawning via RPC
- Remote crash notification to parent
- All three supervision strategies across nodes (one-for-one, one-for-all, rest-for-one)
- Remote child lifecycle (stopped when parent stops)
- Node failure handling for both remote children and orphaned children

## Architecture

### Protocol Design

```
Parent Node (A)                      Child Node (B)
┌─────────────────────┐              ┌─────────────────────┐
│  ParentActor        │              │                     │
│       │             │              │                     │
│  spawnChildRemote() │              │                     │
│       │             │  RPC request │                     │
│       ▼             │  "child:spawn"                     │
│  ActorSystem  ──────┼─────────────►│  ActorSystem        │
│                     │◄─────────────┤  creates child      │
│  stores RemoteChild │  RPC response│  stores RemoteParent│
│                     │              │       │             │
│                     │              │  ChildActor crashes │
│                     │◄─────────────┤       │             │
│  ChildSupervisor    │  "child:crash"       ▼             │
│  applies strategy   │              │  notifies parent    │
│       │             │              │                     │
│       ▼             │  RPC request │                     │
│  "child:restart" ───┼─────────────►│  restarts child     │
│                     │◄─────────────┤                     │
│  updates tracking   │  RPC response│  new child ref      │
└─────────────────────┘              └─────────────────────┘
```

### New RPC Message Types

```typescript
// Spawn child on remote node
type ChildSpawnRequest = {
  type: "child:spawn";
  childInstanceId: string;
  actorClassName: string;
  options: SpawnOptions;
  parentNodeId: string;
  parentActorId: string;
};

// Crash notification from child's node to parent's node
type ChildCrashNotification = {
  type: "child:crash";
  childInstanceId: string;
  childNodeId: string;
  parentActorId: string;
  reason: TerminationReason;
  errorMessage?: string;
};

// Restart request from parent's node to child's node
type ChildRestartRequest = {
  type: "child:restart";
  oldChildInstanceId: string;
  newChildInstanceId: string;
  parentNodeId: string;
  parentActorId: string;
};

// Stop request from parent's node to child's node
type ChildStopRequest = {
  type: "child:stop";
  childInstanceId: string;
  parentNodeId: string;
  parentActorId: string;
};
```

### Key Data Structures

```typescript
// On parent's node - tracks remote children
interface RemoteChildEntry {
  childRef: ActorRef;
  childNodeId: string;
  parentRef: ActorRef;
  actorClass: new () => Actor;
  options: SpawnOptions;
}

// Map: childInstanceId -> RemoteChildEntry
private remoteChildren = new Map<string, RemoteChildEntry>();

// On child's node - tracks remote parent relationship
interface RemoteParentInfo {
  parentNodeId: string;
  parentActorId: string;
}

// Map: childInstanceId -> RemoteParentInfo
private remoteParents = new Map<string, RemoteParentInfo>();
```

## Key Implementation Details

### Remote Child Spawning

The `spawnChildRemote()` method sends an RPC request to the target node:

```typescript
async spawnChildRemote<T extends Actor>(
  parentRef: ActorRef,
  actorClass: new () => T,
  targetNodeId: string,
  options: SpawnOptions = {},
): Promise<ActorRef | null> {
  // Generate instance ID locally
  const childInstanceId = uuidv4();
  
  // Send spawn request to target node
  const response = await this.transport.request(targetNodeId, {
    type: "child:spawn",
    childInstanceId,
    actorClassName: actorClass.name,
    options,
    parentNodeId: this.id,
    parentActorId: parentId,
  }, 5000);
  
  // Store remote child entry and add to parent's children
  // ...
}
```

### Remote Crash Detection

When a child with a remote parent crashes, the supervisor notifies the parent:

```typescript
// In Supervisor.handleCrash()
if (this.system.hasRemoteParent(actorId)) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  this.system.notifyRemoteParentOfCrash(actorId, { type: "error", error }, errorMessage);
  return; // Let remote parent decide restart
}
```

### Remote Supervision Strategies

The `ChildSupervisor` now has methods to handle remote children:

- `handleRemoteChildCrash()` - Entry point for remote crash notifications
- `handleRemoteOneForOne()` - Restart just the crashed remote child
- `handleRemoteOneForAll()` - Stop and restart all children (local + remote)
- `handleRemoteRestForOne()` - Stop and restart crashed child and all after it

### Node Failure Handling

Two new methods handle node failures:

1. `_handleNodeFailureForRemoteChildren()` - When child's node fails, treat all children on that node as crashed
2. `_handleNodeFailureForOrphanedChildren()` - When parent's node fails, stop orphaned children

## Location Transparency

All operations are now location-transparent:

| Operation | Location Check | Local Path | Remote Path |
|-----------|---------------|------------|-------------|
| `cast()` | `systemId === this.id` | Push to mailbox | `transport.send()` |
| `call()` | `systemId === this.id` | Push to mailbox | `transport.request()` |
| `watch()` | `systemId !== this.id` | Store in `watches` | Send `watch:add` RPC |
| `link()` | `systemId !== this.id` | Store in `links` | Send `link:add` RPC |
| `spawnChild()` | N/A (local only) | Local spawn | N/A |
| `spawnChildRemote()` | Always remote | N/A | Send `child:spawn` RPC |
| `stop()` | `systemId === this.id` | Local stop | Send `child:stop` RPC |

## Files Modified

| File | Changes |
|------|---------|
| `src/actor_system.ts` | Added `RemoteChildEntry`, `RemoteParentInfo` interfaces; `remoteChildren`, `remoteParents` maps; `spawnChildRemote()`, `restartRemoteChild()`, `stopRemoteChild()`, `removeRemoteChild()`, `notifyRemoteParentOfCrash()`, `hasRemoteParent()`, `getRemoteChild()` methods; `_handleRemoteChildSpawn()`, `_handleRemoteChildRestart()`, `_handleRemoteChildStop()`, `_handleRemoteChildCrash()`, `_handleNodeFailureForRemoteChildren()`, `_handleNodeFailureForOrphanedChildren()` RPC handlers; Fixed `_handleRpcCast` to route errors through supervisor |
| `src/child_supervisor.ts` | Added `handleRemoteChildCrash()`, `handleRemoteOneForOne()`, `handleRemoteOneForAll()`, `handleRemoteRestForOne()`, `getRestartKeyForRemote()` methods; Added `RemoteChildEntry` interface |
| `src/supervisor.ts` | Added remote parent check in `handleCrash()` to notify remote parent of crashes |

## New Example

`examples/distributed_supervision.ts` - Demonstrates:
- Remote child spawning
- Remote crash with one-for-one restart
- One-for-all strategy with remote children
- Parent shutdown stopping remote children
- Node failure simulation

### Example Output Highlights

```
--- Demo 1: Remote Child Spawning ---
  [Supervisor:S1] Started on node1 (strategy: one-for-one)
  [Worker:W1] Started on node2
  Remote child spawned: fa28d6ff... on node2
  Worker status: {"name":"W1","processed":1,"node":"node2"}

--- Demo 2: Remote Child Crash with One-for-One Restart ---
  Children before crash: 1
  [Worker:W1] Crashing!
  Applying one-for-one strategy for remote child
  [Worker:W1] Started on node2
  Remote child restarted successfully
  Children after crash: 1

--- Demo 3: One-for-All Strategy ---
  Children before crash: 3
  [Worker:W3] Crashing!
  Applying one-for-all strategy (triggered by remote child)
  [Worker:W2] Terminated, [Worker:W3] Terminated, [Worker:W4] Terminated
  [Worker:W2] Started, [Worker:W3] Started, [Worker:W4] Started
  Children after one-for-all restart: 3

--- Demo 4: Parent Shutdown Stops Remote Children ---
  Node2 actors before supervisor stop: 4
  Stopping supervisor S2...
  [Worker:W2] Terminated, [Worker:W3] Terminated, [Worker:W4] Terminated
  Node2 actors after supervisor stop: 1

--- Demo 5: Node Failure Handling ---
  Children before node failure: 1
  Simulating node2 failure...
  Handling remote children on failed node
  Remote child crashed: killed
  Children after node failure: 1 (restarted)
```

## Bug Fix

Fixed a bug in `_handleRpcCast` where errors from remote `cast` messages were not routed through the supervisor:

```typescript
// Before: actor.handleCast(message); // Errors propagated uncaught

// After:
try {
  const result = actor.handleCast(message);
  if (result instanceof Promise) {
    result.catch((err) => {
      const actorRef = new ActorRef(actorId, this);
      this.supervisor.handleCrash(actorRef, err);
    });
  }
} catch (err) {
  const actorRef = new ActorRef(actorId, this);
  this.supervisor.handleCrash(actorRef, err);
}
```

## Next Steps

1. **Heartbeat Protocol** - Automatic failure detection between nodes
2. **Actor Migration** - Move actors between nodes
3. **Distributed GenServer** - Higher-level abstraction for distributed actors

## Commits This Session

1. Implement distributed actor supervision
