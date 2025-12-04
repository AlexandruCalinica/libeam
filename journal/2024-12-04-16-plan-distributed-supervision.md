# Entry 16: Plan - Distributed Supervision

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
- **Entry 16 (Current)**: Plan - Distributed Supervision

## Feature Overview

### Problem Statement

Currently, child actors can only be spawned locally (co-located on the same node as the parent). This limits the ability to:
- Distribute workload across multiple nodes while maintaining supervision
- Build fault-tolerant distributed systems where children run on different nodes
- Leverage the full cluster for actor placement while keeping supervisor semantics

### Goals

1. **Remote child spawning**: Parent on node A can spawn supervised child on node B
2. **Remote crash notification**: When remote child crashes, parent's supervisor is notified
3. **Remote restart strategies**: Apply one-for-one, one-for-all, rest-for-one across nodes
4. **Remote child lifecycle**: Stop remote children when parent stops
5. **Node failure handling**: Clean up remote children tracking when nodes fail

### Non-Goals

- **Distributed restart counting consensus**: Restart counts will be tracked on parent's node only (not replicated)
- **Child migration**: Moving a running child to a different node (future work)
- **Automatic child placement**: Using placement strategies for children (children will have explicit node targeting)
- **Supervision tree distribution**: Replicating entire supervision trees for HA (future work)

## Current State Analysis

### Relevant Existing Code

| File | Purpose | Relevance |
|------|---------|-----------|
| `src/child_supervisor.ts:1-230` | Child supervision strategies | Core logic to extend for remote children |
| `src/actor_system.ts:439-520` | `spawnChild()` method | Entry point - needs remote spawn option |
| `src/actor_system.ts:667-798` | `watch()`/`unwatch()` remote | Pattern for remote RPC setup |
| `src/actor_system.ts:829-1072` | `link()`/`unlink()` remote | Pattern for remote crash propagation |
| `src/actor_system.ts:2004-2308` | Remote watch/link handlers | Model for new RPC handlers |
| `src/actor_system.ts:2340-2494` | Node failure handling | Extend for remote children cleanup |
| `src/supervisor.ts:1-50` | Base supervisor (handleCrash) | Routes crashes to child_supervisor |

### Patterns to Follow

1. **RPC Message Pattern** (from watch/link):
   - Request type: `feature:add` with correlation data
   - Response: `{ success: boolean, alreadyDead?: boolean }`
   - Notification type: `feature:event` for async events
   - Cleanup type: `feature:remove`

2. **Remote Tracking Pattern**:
   - Local map for outgoing refs: `Map<refId, LocalEntry>` (e.g., `remoteWatches`)
   - Remote map for incoming refs: `Map<actorId, Set<RemoteInfo>>` (e.g., `remoteWatchers`)

3. **Node Failure Handling Pattern**:
   - `handleNodeFailure()` iterates tracking maps
   - Sends synthetic "killed" notifications for affected actors

### Integration Points

1. **ActorSystem.spawnChild()** - Add `targetNodeId` option
2. **ChildSupervisor.handleChildCrash()** - Handle remote child crashes
3. **ActorSystem.stop()** - Stop remote children before parent
4. **ActorSystem._handleRpcCall()** - Add spawn request handler
5. **ActorSystem._handleRpcCast()** - Add crash notification handler
6. **ActorSystem.handleNodeFailure()** - Clean up remote children

## Proposed Design

### Architecture

```
Parent Node (A)                      Child Node (B)
┌─────────────────────┐              ┌─────────────────────┐
│  ParentActor        │              │                     │
│       │             │              │                     │
│  spawnChild(B)      │              │                     │
│       │             │              │                     │
│       ▼             │  RPC request │                     │
│  ActorSystem  ──────┼─────────────►│  ActorSystem        │
│  "child:spawn"      │              │  creates child      │
│       │             │◄─────────────┤  "child:spawned"    │
│  stores RemoteChild │  RPC response│  stores RemoteParent│
│                     │              │       │             │
│                     │              │  ChildActor crashes │
│                     │◄─────────────┤       │             │
│  receives crash     │  "child:crash"       ▼             │
│  applies strategy   │              │  ActorSystem        │
│       │             │              │  notifies parent    │
│       ▼             │              │                     │
│  ChildSupervisor    │  RPC request │                     │
│  "child:restart" ───┼─────────────►│  restarts child     │
│                     │◄─────────────┤  "child:restarted"  │
└─────────────────────┘              └─────────────────────┘
```

### New Data Structures

```typescript
// On parent's node - tracks remote children
interface RemoteChildEntry {
  childRef: ActorRef;           // Ref to the remote child
  childNodeId: string;          // Node where child lives
  parentRef: ActorRef;          // Ref to the local parent
  actorClass: new () => Actor;  // For restarts
  options: SpawnOptions;        // For restarts
}

// Map: childInstanceId -> RemoteChildEntry
private remoteChildren = new Map<string, RemoteChildEntry>();

// On child's node - tracks remote parent relationship
interface RemoteParentInfo {
  parentNodeId: string;
  parentActorId: string;
  supervisionOptions: ChildSupervisionOptions;
}

// Map: childInstanceId -> RemoteParentInfo
private remoteParents = new Map<string, RemoteParentInfo>();
```

### New RPC Message Types

```typescript
// ===== Spawn =====

// Parent node -> Child node (request-reply)
interface ChildSpawnRequest {
  type: "child:spawn";
  childInstanceId: string;      // Pre-generated by parent
  actorClassName: string;       // Must be registered on child node
  options: SpawnOptions;        // name, args
  parentNodeId: string;
  parentActorId: string;
  supervisionOptions: ChildSupervisionOptions;
}

interface ChildSpawnResponse {
  success: boolean;
  childActorId?: string;        // Full actor ID on success
  error?: string;               // Error message on failure
}

// ===== Crash Notification =====

// Child node -> Parent node (fire-and-forget)
interface ChildCrashNotification {
  type: "child:crash";
  childInstanceId: string;
  childNodeId: string;
  parentActorId: string;
  reason: TerminationReason;
  errorMessage?: string;
}

// ===== Restart =====

// Parent node -> Child node (request-reply)
interface ChildRestartRequest {
  type: "child:restart";
  oldChildInstanceId: string;
  newChildInstanceId: string;   // Pre-generated by parent
  parentNodeId: string;
  parentActorId: string;
}

interface ChildRestartResponse {
  success: boolean;
  newChildActorId?: string;
  error?: string;
}

// ===== Stop =====

// Parent node -> Child node (request-reply)
interface ChildStopRequest {
  type: "child:stop";
  childInstanceId: string;
  parentNodeId: string;
  parentActorId: string;
}

interface ChildStopResponse {
  success: boolean;
  error?: string;
}

// ===== Stop All (for one-for-all, rest-for-one) =====

// Parent node -> Child node (request-reply)
interface ChildStopAllRequest {
  type: "child:stop-all";
  childInstanceIds: string[];
  parentNodeId: string;
  parentActorId: string;
}

interface ChildStopAllResponse {
  success: boolean;
  stoppedIds: string[];
  errors?: Record<string, string>;
}
```

### Key Algorithms/Logic

#### Remote Spawn Flow

1. Parent calls `spawnChild(parentRef, actorClass, { targetNodeId: "node2", ... })`
2. ActorSystem detects `targetNodeId !== this.id`
3. Generate `childInstanceId` locally (UUID)
4. Send `child:spawn` RPC to target node
5. On success: store `RemoteChildEntry`, add synthetic ref to parent's children
6. On failure: throw error

#### Remote Crash Handling Flow

1. Child crashes on node B
2. Node B's supervisor detects crash
3. Check if child has `RemoteParentInfo` → yes
4. Send `child:crash` notification to parent's node
5. Parent's node routes to `ChildSupervisor.handleRemoteChildCrash()`
6. Child supervisor applies strategy (one-for-one, etc.)
7. For restart: send `child:restart` RPC back to child's node

#### Remote Stop Flow (Parent Stopping)

1. Parent's `stop()` called
2. Collect all children (local + remote from `remoteChildren`)
3. For remote children: send `child:stop` RPC
4. Wait for responses (with timeout)
5. Clean up tracking maps
6. Continue with parent termination

## Implementation Plan

### Phase 1: Core Infrastructure

1. [ ] Add `RemoteChildEntry` and `RemoteParentInfo` interfaces to `actor_system.ts`
2. [ ] Add `remoteChildren` and `remoteParents` maps to ActorSystem
3. [ ] Add RPC message type interfaces
4. [ ] Add `child:spawn` handler in `_handleRpcCall()`
5. [ ] Add `child:crash` handler in `_handleRpcCast()`
6. [ ] **Checkpoint**: Can receive and parse child RPC messages

### Phase 2: Remote Child Spawning

1. [ ] Modify `spawnChild()` signature to accept optional `targetNodeId` in options
2. [ ] Implement `_spawnChildRemote()` method for remote spawn logic
3. [ ] Send `child:spawn` RPC request and handle response
4. [ ] Store `RemoteChildEntry` on parent's node
5. [ ] Store `RemoteParentInfo` on child's node
6. [ ] Add child to parent's `children` Set and `childOrder` array (as remote ref)
7. [ ] **Checkpoint**: Can spawn child on remote node, parent knows about child

### Phase 3: Remote Crash Detection & Notification

1. [ ] Modify child node's crash handling to check for `RemoteParentInfo`
2. [ ] Send `child:crash` notification when remote parent exists
3. [ ] Create `ChildSupervisor.handleRemoteChildCrash()` method
4. [ ] Route incoming `child:crash` to ChildSupervisor
5. [ ] Apply restart limit checking (using existing `canRestart()`)
6. [ ] **Checkpoint**: Remote child crash triggers parent notification

### Phase 4: Remote Restart Strategies

1. [ ] Implement `child:restart` RPC handler on child's node
2. [ ] Implement `_restartRemoteChild()` in ChildSupervisor for one-for-one
3. [ ] Send `child:restart` request and update tracking on success
4. [ ] Implement `child:stop-all` RPC handler for batch stops
5. [ ] Extend `handleOneForAll()` to handle remote children
6. [ ] Extend `handleRestForOne()` to handle remote children
7. [ ] **Checkpoint**: All three supervision strategies work with remote children

### Phase 5: Remote Child Lifecycle

1. [ ] Add `child:stop` RPC handler on child's node
2. [ ] Modify `ActorSystem.stop()` to stop remote children
3. [ ] Implement `_stopRemoteChildren()` helper
4. [ ] Add timeout for remote stop operations
5. [ ] Clean up `remoteChildren` and `remoteParents` maps on stop
6. [ ] **Checkpoint**: Stopping parent stops all remote children

### Phase 6: Node Failure Handling

1. [ ] Add `_handleNodeFailureForRemoteChildren()` method
2. [ ] When child's node fails: clean up parent's tracking, notify parent actor
3. [ ] When parent's node fails: stop orphaned children
4. [ ] Integrate with existing `handleNodeFailure()` method
5. [ ] **Checkpoint**: Node failures properly clean up remote supervision

### Phase 7: Testing & Example

1. [ ] Create `examples/distributed_supervision.ts` demonstrating:
   - Basic remote child spawn
   - Remote crash with one-for-one restart
   - Remote crash with one-for-all restart
   - Parent shutdown stopping remote children
   - Node failure simulation
2. [ ] Add unit tests for remote spawn
3. [ ] Add unit tests for remote crash notification
4. [ ] Add integration tests for supervision strategies
5. [ ] **Checkpoint**: Feature complete with tests passing

## Testing Strategy

### Unit Tests

- [ ] `spawnChild()` with `targetNodeId` calls `_spawnChildRemote()`
- [ ] `RemoteChildEntry` stored correctly on parent node
- [ ] `RemoteParentInfo` stored correctly on child node
- [ ] `child:spawn` handler creates actor and stores metadata
- [ ] `child:crash` notification triggers `handleRemoteChildCrash()`
- [ ] Restart limits work for remote children
- [ ] `child:restart` handler restarts actor correctly
- [ ] `child:stop` handler stops actor and cleans up
- [ ] Parent `stop()` sends `child:stop` for remote children

### Integration Tests

- [ ] Remote child spawn and basic messaging
- [ ] Remote child crash triggers one-for-one restart
- [ ] Remote child crash triggers one-for-all (stops/restarts all children)
- [ ] Remote child crash triggers rest-for-one (stops/restarts subset)
- [ ] Max restarts exceeded stops remote child
- [ ] Parent stop terminates remote children
- [ ] Node failure cleans up orphaned children

### Manual Verification

- [ ] Run `examples/distributed_supervision.ts`
- [ ] Verify logs show cross-node RPC messages
- [ ] Kill child node process, verify parent handles failure
- [ ] Kill parent node process, verify children are stopped

## Edge Cases & Error Handling

| Scenario | Expected Behavior |
|----------|-------------------|
| Child node unreachable during spawn | Throw error, don't add to parent's children |
| Child node unreachable during restart | Mark child as dead, notify parent actor |
| Child node unreachable during stop | Timeout, force cleanup tracking |
| Parent node unreachable during crash notify | Child continues, orphaned until node failure detected |
| Actor class not registered on child node | Return error in `child:spawn` response |
| Child crashes during pending restart | Queue notification, process after restart completes |
| Multiple rapid crashes | Restart limit applies per stable key (survives restarts) |
| Parent crashes while child is crashing | Node failure handling cleans up |

## Open Questions

- [x] **Restart count location**: Track on parent node only (simpler, parent owns supervision)
- [ ] **Stop timeout value**: What timeout for remote stop? (Suggest: 5 seconds, configurable)
- [ ] **Orphan detection**: Should children periodically heartbeat to parent? (Suggest: No, rely on node failure detection)
- [ ] **Actor class registration**: Require explicit registration or auto-detect? (Suggest: Explicit, like current `registerActorClass()`)

## Dependencies

- Requires `registerActorClass()` to be called on child node before spawning
- Uses existing transport layer (no changes needed)
- Uses existing registry for name registration (child registers locally)

## Next Steps

After this plan is approved:
1. Implement Phase 1: Core Infrastructure
2. Implement Phase 2: Remote Child Spawning
3. Run manual test to verify spawn works
4. Continue with remaining phases
