# Research: Graceful Shutdown

**Date**: 2024-12-05
**Git Commit**: 59beba7
**Branch**: main

## Research Question

How does the codebase handle graceful shutdown at various levels (actors, actor system, gossip protocol, cluster)?

## Summary

The codebase has comprehensive graceful shutdown support at multiple layers: ActorSystem shutdown with mailbox draining, actor-level terminate hooks, gossip protocol `leave()` with status broadcasting, and transport disconnect cleanup. The gossip protocol explicitly distinguishes graceful leave (status: "leaving") from failure detection (timeout-based), emitting `member_leave` events in both cases but with different status values.

## Key Files

| File | Purpose | Lines |
|------|---------|-------|
| `src/actor_system.ts` | System shutdown, actor stop, node failure handling | L43-47, L176-180, L269-315, L1772-1826 |
| `src/gossip_protocol.ts` | Graceful leave with status broadcast | L28-33, L83-108, L134-147, L202-217 |
| `src/gossip.ts` | PeerStatus type definition | L3 |
| `src/zeromq_transport.ts` | Transport disconnect cleanup | L79-97 |
| `src/actor.ts` | Actor terminate hook | L285-287 |

## Detailed Findings

### ActorSystem Shutdown

**State Flags** (`actor_system.ts:179-180`):
```typescript
private _isShuttingDown = false;
private _isRunning = false;
```

**ShutdownOptions Interface** (`actor_system.ts:43-47`):
```typescript
interface ShutdownOptions {
  timeout?: number;           // Timeout for mailbox draining (default: 5000ms)
  drainMailboxes?: boolean;   // Wait for mailboxes to empty (default: true)
}
```

**Shutdown Sequence** (`actor_system.ts:269-315`):
1. Sets `_isShuttingDown = true` (blocks new spawns)
2. Drains mailboxes with timeout via `_drainMailboxes()`
3. Iterates all actors, unregisters names, calls `terminate()`
4. Clears all tracking maps
5. Sets `_isRunning = false`

**Spawn Rejection** (`actor_system.ts:381-384`):
```typescript
if (this._isShuttingDown) {
  throw new SystemShuttingDownError("spawn actors");
}
```

### Actor Stop (Single Actor)

**Stop Method** (`actor_system.ts:1772-1826`):
1. Cascading termination: stops all children first (local and remote)
2. Removes from parent's children set
3. Cleans up watches via `unwatch()`
4. Cancels all timers via `cancelAllActorTimers()`
5. Clears idle timeout via `_clearIdleTimeout()`
6. Notifies watchers (reason: "normal")
7. Notifies linked actors (reason: "normal")
8. Unregisters name from registry
9. Calls `actor.terminate()`
10. Deletes from all tracking maps

### Gossip Protocol Graceful Leave

**PeerStatus Type** (`gossip.ts:3`):
```typescript
export type PeerStatus = "alive" | "leaving" | "dead";
```

**Leave State Flag** (`gossip_protocol.ts:28`):
```typescript
private _isLeaving = false;
```

**Leave Method** (`gossip_protocol.ts:83-108`):
```typescript
async leave(broadcastCount = 3, intervalMs = 100): Promise<void> {
  if (this._isLeaving) return;
  
  this._isLeaving = true;
  this.self.status = "leaving";
  this.self.heartbeat++;
  this.self.lastUpdated = Date.now();
  this.peers.set(this.self.id, this.self);

  // Broadcast leave message multiple times
  for (let i = 0; i < broadcastCount; i++) {
    await this._broadcastToAllPeers();
    if (i < broadcastCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  await this.stop();
}
```

**Key behaviors:**
- Sets status to "leaving" and increments heartbeat
- Broadcasts 3 times (default) with 100ms intervals
- Peers detect status transition and emit `member_leave`

**getLivePeers Filtering** (`gossip_protocol.ts:134-147`):
- Excludes peers with `status === "leaving"` (except self)
- Self is always included until protocol stops

**Message Handling** (`gossip_protocol.ts:202-217`):
- Detects transition from "alive" to "leaving"
- Emits `member_leave` event on status change
- Rejects new peers already in "leaving" state

### Graceful Leave vs Failure Detection

| Aspect | Graceful Leave | Failure Detection |
|--------|----------------|-------------------|
| **Trigger** | `leave()` method call | Timeout in `failureDetectionLoop()` |
| **Status** | Set to "leaving" | No status update |
| **Broadcast** | 3× with 100ms intervals | No explicit broadcast |
| **Event** | `member_leave` after status change | `member_leave` after timeout |
| **Detection Time** | ~300ms | Up to `failureTimeoutMs` |

### Transport Disconnect

**Disconnect Method** (`zeromq_transport.ts:79-97`):
1. Rejects all pending requests with "Transport disconnected"
2. Clears pending requests map
3. Closes ROUTER socket (RPC)
4. Closes PUB socket
5. Closes SUB socket
6. Closes all DEALER sockets to peers

### Node Failure Handling

**handleNodeFailure** (`actor_system.ts:3029-3044`):
```typescript
handleNodeFailure(deadNodeId: string): void {
  this._handleNodeFailureForWatches(deadNodeId);
  this._handleNodeFailureForLinks(deadNodeId);
  this._handleNodeFailureForRemoteChildren(deadNodeId);
  this._handleNodeFailureForOrphanedChildren(deadNodeId);
}
```

Called when `member_leave` is received from gossip/cluster.

### Signal Handling in Examples

**SIGINT Handler** (`examples/distributed_ping_pong.ts:220-226`):
```typescript
process.on("SIGINT", async () => {
  await system.shutdown();
  await cluster.leave();
  await transport.disconnect();
  process.exit(0);
});
```

Shutdown sequence: ActorSystem → Cluster leave → Transport disconnect

## Type Definitions

```typescript
// src/actor_system.ts:43-47
interface ShutdownOptions {
  timeout?: number;
  drainMailboxes?: boolean;
}

// src/gossip.ts:3
type PeerStatus = "alive" | "leaving" | "dead";

// src/gossip.ts:6-20
interface PeerState {
  id: string;
  address: string;
  heartbeat: number;
  generation: number;
  gossipAddress: string;
  lastUpdated: number;
  status?: PeerStatus;
}
```

## Usage Patterns

**System Shutdown:**
```typescript
await system.shutdown({ timeout: 10000, drainMailboxes: true });
```

**Gossip Leave:**
```typescript
await gossipProtocol.leave(3, 100);  // 3 broadcasts, 100ms interval
```

**Full Shutdown Sequence:**
```typescript
await system.shutdown();
await cluster.leave();
await transport.disconnect();
```

## Dependencies

- **Internal**: Supervisor, ChildSupervisor, Registry, Transport
- **External**: None for shutdown logic

## Architecture Notes

1. **Layered shutdown**: Each layer (actor, system, gossip, transport) handles its own cleanup
2. **Status-based detection**: Gossip uses explicit "leaving" status to distinguish graceful leave from failure
3. **Multiple broadcasts**: Leave broadcasts 3× to ensure delivery over UDP
4. **Cascading termination**: Parent stop triggers child stops recursively
5. **Event-driven cleanup**: `member_leave` event triggers `handleNodeFailure()` for distributed cleanup

## Test Coverage

- `test/actor_system.test.ts` - Shutdown, cascade termination, spawn rejection
- `test/gossip_protocol.test.ts` - Graceful leave, peer notification
- `test/actor_links.test.ts` - Crash vs graceful distinction in link propagation
- `test/distributed_watching.test.ts` - Node failure handling

## Implications for Heartbeat Protocol

1. **Graceful shutdown awareness**: Heartbeat should check if peer has `status === "leaving"` before declaring failure
2. **Integration with gossip**: Listen to `member_leave` events to remove peers from heartbeat tracking
3. **Avoid false positives**: During graceful shutdown, peer may stop responding to pings - check leave status first
4. **Shutdown order**: Heartbeat manager should stop before gossip `leave()` to prevent false failure detection
