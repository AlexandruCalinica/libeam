# Entry 14: Distributed Actor Watching

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
- **Entry 14 (Current)**: Distributed actor watching

## Current State

### Test Status: 149 tests passing (9 new)

### New Features Implemented

**Distributed Actor Watching** - Actors can now watch actors on remote nodes and receive DOWN notifications when they terminate.

## Architecture

### Protocol Design

```
Node A (watcher)                    Node B (watched)
┌─────────────────┐                ┌─────────────────┐
│  WatcherActor   │                │  WatchedActor   │
│       │         │                │       │         │
│   watch(B)      │                │                 │
│       │         │                │                 │
│       ▼         │   RPC request  │                 │
│  ActorSystem ───┼───────────────►│  ActorSystem    │
│  (remote watch) │  "watch:add"   │  stores reverse │
│                 │                │  mapping        │
│                 │                │       │         │
│                 │                │  actor dies     │
│                 │   RPC notify   │       │         │
│  receives DOWN ◄┼────────────────┤  notifies all   │
│  via handleInfo │  "watch:down"  │  remote watchers│
└─────────────────┘                └─────────────────┘
```

### New RPC Message Types

```typescript
// Sent from watcher's node to watched actor's node
type WatchAddRequest = {
  type: "watch:add";
  watchRefId: string;
  watcherNodeId: string;
  watcherActorId: string;
  watchedActorId: string;
};

// Response from watched actor's node
type WatchAddResponse = {
  success: boolean;
  alreadyDead?: boolean;  // If watched actor is already dead
};

// Sent when watched actor dies
type WatchDownNotification = {
  type: "watch:down";
  watchRefId: string;
  watchedActorId: string;
  reason: TerminationReason;
};

// Sent to cancel a remote watch
type WatchRemoveRequest = {
  type: "watch:remove";
  watchRefId: string;
  watchedActorId: string;
};
```

### Key Data Structures

```typescript
// On watched actor's node - tracks who is watching local actors
interface RemoteWatcherInfo {
  watchRefId: string;
  watcherNodeId: string;
  watcherActorId: string;
}

// Map: watchedActorId -> Set<RemoteWatcherInfo>
private remoteWatchers = new Map<string, Set<RemoteWatcherInfo>>();

// On watcher's node - tracks remote actors being watched
interface RemoteWatchEntry {
  watchRef: WatchRef;
  watcherRef: ActorRef;
  watchedNodeId: string;
  watchedActorId: string;
}

// Map: watchRefId -> RemoteWatchEntry
private remoteWatches = new Map<string, RemoteWatchEntry>();
```

## Key Implementation Details

### watch() Method Enhancement

The `watch()` method now detects if the target actor is remote:

```typescript
watch(watcherRef: ActorRef, watchedRef: ActorRef): WatchRef {
  const watchedNodeId = watchedRef.id.systemId;
  const isRemoteWatch = watchedNodeId !== this.id;

  if (isRemoteWatch) {
    return this._setupRemoteWatch(watchRef, watcherRef, watchedRef);
  }
  // ... local watch logic
}
```

### Remote Watch Setup Flow

1. Create WatchRef locally
2. Store in `remoteWatches` map
3. Send `watch:add` RPC to remote node
4. Remote node stores in `remoteWatchers` map
5. If actor already dead, respond with `alreadyDead: true`
6. On error/timeout, treat as actor dead

### Actor Termination Notification Flow

When an actor dies on Node B:

1. `notifyWatchers()` is called
2. Notifies local watchers (existing behavior)
3. Iterates through `remoteWatchers` for that actor
4. Sends `watch:down` message to each remote node
5. Remote node receives, delivers DOWN to watcher via `handleInfo()`

### Node Failure Handling

When `handleNodeFailure(deadNodeId)` is called:

1. Find all remote watches pointing to dead node
2. Send DOWN message to each local watcher (reason: "killed")
3. Clean up `remoteWatches` entries
4. Also clean up `remoteWatchers` entries from the dead node

## Files Modified

| File | Changes |
|------|---------|
| `src/actor_system.ts` | Added `RemoteWatcherInfo`, `RemoteWatchEntry` interfaces; `remoteWatchers`, `remoteWatches` maps; `_setupRemoteWatch()`, `_unwatchRemote()`, `_notifyRemoteWatcher()`, `_handleRemoteWatchAdd()`, `_handleRemoteWatchRemove()`, `_handleRemoteDown()`, `handleNodeFailure()` methods; updated `watch()`, `unwatch()`, `notifyWatchers()`, `_handleRpcCall()`, `_handleRpcCast()` |

## New Test File

`test/distributed_watching.test.ts` - 9 tests:
- Remote watch setup and DOWN notification
- Remote actor crash notification
- Unwatching remote actors
- Watching already-dead remote actors
- Multiple remote watchers
- Node failure bulk notification
- Remote watcher cleanup on node failure
- WatchRef in remote DOWN message
- Bidirectional remote watching

## New Example

`examples/distributed_watching.ts` - Demonstrates:
- Basic remote watch setup
- Graceful shutdown notification
- Crash notification
- Node failure simulation

## Usage Example

```typescript
// Node 1: Supervisor watches remote services
const supervisor = node1.spawn(SupervisorActor);

// Node 2: Services
const authService = node2.spawn(AuthService);
const dbService = node2.spawn(DatabaseService);

// Supervisor watches remote services (just like local!)
supervisor.cast({ type: "watch", target: authService });
supervisor.cast({ type: "watch", target: dbService });

// When authService dies, supervisor receives DOWN via handleInfo()
// When node2 fails, call node1.handleNodeFailure("node2") to notify watchers
```

## Wiring Up Node Failure Detection

The `handleNodeFailure()` method should be wired to membership events:

```typescript
// In your application setup:
membership.on('member_leave', (nodeId) => {
  system.handleNodeFailure(nodeId);
});
```

## What's NOT Implemented (Yet)

### Distributed Links
- Links require bidirectional crash propagation
- More complex than watching (one-way notification)
- Would need similar protocol but with crash propagation logic

### Distributed Supervision
- Children can only be spawned on same node as parent
- Cross-node supervision requires additional design work

## Next Steps

1. **Distributed Links** - Bidirectional crash propagation across nodes
2. **Distributed Supervision** - Spawn and supervise children on remote nodes
3. **Heartbeat Protocol** - Automatic failure detection between nodes

## Commits This Session

1. `Implement distributed actor watching`
