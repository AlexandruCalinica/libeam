# Entry 18: Plan - Heartbeat Protocol

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
- **Entry 17**: Distributed Supervision
- **Entry 18 (Current)**: Plan - Heartbeat Protocol

## Feature Overview

### Problem Statement

Currently, node failure detection relies solely on the gossip protocol's passive timeout mechanism:
- `failureDetectionLoop()` runs at `cleanupIntervalMs` intervals
- Marks peers dead if `now - lastUpdated > failureTimeoutMs`
- No active probing - waits for gossip updates to stop

This has limitations:
1. **Slow detection**: Must wait for `failureTimeoutMs` (typically several seconds)
2. **No transport verification**: Gossip uses UDP, but actor messages use ZeroMQ RPC
3. **Coarse granularity**: Can't detect partial failures (e.g., ZeroMQ down but UDP working)

### Goals

- **Fast failure detection**: Detect node failures within 1-3 seconds (configurable)
- **Transport-layer verification**: Use the same RPC transport as actor messages
- **Configurable behavior**: Allow tuning intervals, timeouts, and thresholds
- **Integration with existing failure handlers**: Trigger `handleNodeFailure()` on detection
- **Minimal overhead**: Efficient ping/pong with small message payloads

### Non-Goals

- Replacing gossip protocol (heartbeat complements it)
- Application-level health checks (this is node-level connectivity)
- Automatic node recovery/reconnection (handled elsewhere)

## Current State Analysis

### Relevant Existing Code

| File | Purpose | Relevance |
|------|---------|-----------|
| `src/gossip_protocol.ts` | Passive failure detection via gossip timeouts | Pattern to follow for intervals/loops |
| `src/transport.ts:L30-35` | `request(nodeId, message, timeout)` | Will use for ping/pong RPC |
| `src/actor_system.ts:L3029-3044` | `handleNodeFailure(deadNodeId)` | Integration point for failure callbacks |
| `src/actor_system.ts:L176-180` | ActorSystem constructor | Where to inject HeartbeatManager |
| `src/custom_gossip_cluster.ts` | Cluster interface with `getLivePeers()` | Source of peer list for heartbeating |

### Patterns to Follow

1. **Interval-based loops** (from `GossipProtocol`):
   ```typescript
   this.heartbeatIntervalTimer = setInterval(() => {
     this.heartbeatLoop();
   }, this.options.intervalMs);
   ```

2. **EventEmitter for notifications** (from `GossipProtocol`):
   ```typescript
   this.emit('node_failed', nodeId);
   ```

3. **RPC message types** (from existing handlers):
   ```typescript
   type HeartbeatPing = { type: "heartbeat:ping"; ... };
   ```

### Integration Points

1. **ActorSystem** - Owns HeartbeatManager, receives `node_failed` events
2. **Transport** - Uses `request()` for ping, `onRequest()` for pong handler
3. **Cluster** - Provides `getLivePeers()` for peer list
4. **Existing handlers** - `handleNodeFailure()` already handles all cleanup

## Proposed Design

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           ActorSystem                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                     HeartbeatManager                          │   │
│  │                                                               │   │
│  │  heartbeatLoop() ─────► sendPing(nodeId) ─────► Transport     │   │
│  │       │                      │                     │          │   │
│  │       │                      ▼                     │          │   │
│  │       │              track pending pings           │          │   │
│  │       │                      │                     │          │   │
│  │       │                      ▼                     ▼          │   │
│  │       │              onPong() ◄──────────── RPC response      │   │
│  │       │                      │                                │   │
│  │       │                      ▼                                │   │
│  │       │              updatePeerStatus()                       │   │
│  │       │                      │                                │   │
│  │       ▼                      ▼                                │   │
│  │  failureCheck() ────► missedHeartbeats > max?                 │   │
│  │                              │                                │   │
│  │                              ▼ yes                            │   │
│  │                       emit('node_failed')                     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                │                                     │
│                                ▼                                     │
│                     handleNodeFailure(deadNodeId)                    │
│                                │                                     │
│         ┌──────────────────────┼──────────────────────┐             │
│         ▼                      ▼                      ▼             │
│  _handleNodeFailure     _handleNodeFailure     _handleNodeFailure   │
│  ForWatches()           ForLinks()             ForRemoteChildren()  │
└─────────────────────────────────────────────────────────────────────┘
```

### New Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `HeartbeatManager` | Active failure detection via ping/pong | `src/heartbeat.ts` |
| `HeartbeatConfig` | Configuration interface | `src/heartbeat.ts` |

### Modified Components

| Component | Changes Needed |
|-----------|----------------|
| `src/actor_system.ts` | Create HeartbeatManager, wire up `node_failed` event, add RPC handlers for ping/pong |
| `src/index.ts` | Export HeartbeatConfig for users to configure |

### Data Structures

```typescript
// src/heartbeat.ts

export interface HeartbeatConfig {
  /** Enable/disable heartbeat protocol. Default: true */
  enabled: boolean;
  
  /** How often to run the heartbeat loop (ms). Default: 1000 */
  intervalMs: number;
  
  /** Timeout waiting for pong response (ms). Default: 2000 */
  timeoutMs: number;
  
  /** Number of missed heartbeats before declaring node dead. Default: 3 */
  maxMissedHeartbeats: number;
  
  /** Stagger pings across interval to avoid network bursts. Default: true */
  staggerPings: boolean;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  intervalMs: 1000,
  timeoutMs: 2000,
  maxMissedHeartbeats: 3,
  staggerPings: true,
};

// Tracks state per peer
interface PeerHeartbeatState {
  nodeId: string;
  missedCount: number;
  lastPongTime: number;
  pendingPing: boolean;
  isLeaving: boolean;  // Track if peer announced graceful leave
}

// RPC message types
type HeartbeatPing = {
  type: "heartbeat:ping";
  timestamp: number;
  senderId: string;
};

type HeartbeatPong = {
  type: "heartbeat:pong";
  timestamp: number;  // Echo original timestamp for RTT calculation
  responderId: string;
};
```

### Key Algorithms/Logic

**Heartbeat Loop (runs every `intervalMs`):**
```
peers = getLivePeers().filter(p => p.id !== self.id)

if staggerPings:
  staggerDelayMs = intervalMs / peers.length
  for each peer (with index i):
    setTimeout(() => pingPeer(peer), i * staggerDelayMs)
else:
  for each peer:
    pingPeer(peer)

function pingPeer(peer):
  if peer.isLeaving: skip  // Don't ping leaving peers
  if peer has pending ping:
    peer.missedCount++
    if peer.missedCount >= maxMissedHeartbeats:
      emit('node_failed', peer.nodeId)
      remove peer from tracking
  else:
    send ping to peer
    mark peer as pending
```

**Pong Handler:**
```
on pong received:
  peer.pendingPing = false
  peer.missedCount = 0
  peer.lastPongTime = now
```

**Ping Handler:**
```
on ping received:
  respond with pong (echo timestamp)
```

**Graceful Shutdown Integration:**
```
// On member_leave event from cluster:
if peer.status === "leaving":
  peer.isLeaving = true  // Mark as leaving, don't declare failure
  remove from tracking after short delay  // Let graceful shutdown complete
else:
  // Failure detected by gossip, remove immediately
  remove from tracking
```

**Shutdown Order:**
```
1. HeartbeatManager.stop()  // Stop sending pings first
2. cluster.leave()          // Broadcast "leaving" status
3. transport.disconnect()   // Close sockets
```

## Implementation Plan

### Phase 1: Core HeartbeatManager

1. [ ] Create `src/heartbeat.ts` with:
   - `HeartbeatConfig` interface
   - `DEFAULT_HEARTBEAT_CONFIG` constant
   - `HeartbeatManager` class skeleton
   - `PeerHeartbeatState` interface
   - Ping/Pong message types

2. [ ] Implement `HeartbeatManager` core:
   - Constructor accepting transport, cluster, config
   - `start()` / `stop()` lifecycle methods
   - `heartbeatLoop()` - periodic ping sending
   - Peer state tracking map

3. [ ] Checkpoint: HeartbeatManager can be instantiated and started

### Phase 2: RPC Integration

1. [ ] Add ping/pong RPC handlers in `ActorSystem`:
   - `_handleHeartbeatPing()` - respond with pong
   - Wire into `_handleRpcCall()` message routing

2. [ ] Implement ping sending in HeartbeatManager:
   - Use `transport.request()` for ping with timeout
   - Handle pong responses
   - Handle timeout (increment missed count)

3. [ ] Checkpoint: Nodes can ping each other and receive pongs

### Phase 3: Failure Detection

1. [ ] Implement failure detection logic:
   - Track missed heartbeats per peer
   - Emit `node_failed` event when threshold exceeded
   - Handle peer removal on failure

2. [ ] Wire HeartbeatManager into ActorSystem:
   - Add optional `heartbeatConfig` to constructor
   - Create HeartbeatManager in constructor
   - Listen to `node_failed` events
   - Call `handleNodeFailure()` on detection

3. [ ] Checkpoint: Node failures are detected and trigger cleanup

### Phase 4: Peer Lifecycle & Graceful Shutdown

1. [ ] Handle new peer discovery:
   - Listen to cluster `member_join` events
   - Add new peers to heartbeat tracking

2. [ ] Handle peer departure:
   - Listen to cluster `member_leave` events
   - Check if peer has `status === "leaving"` (graceful) vs timeout (failure)
   - For graceful leave: mark `isLeaving = true`, remove from tracking without failure event
   - For failure: remove from tracking (gossip already detected failure)
   - Avoid duplicate failure notifications

3. [ ] Implement proper shutdown order:
   - HeartbeatManager.stop() cancels all pending pings and timers
   - Must be called before `cluster.leave()` to avoid false positives
   - Update examples to show correct shutdown sequence

4. [ ] Checkpoint: Dynamic peer management and graceful shutdown work correctly

### Phase 5: Testing & Example

1. [ ] Write unit tests in `test/heartbeat.test.ts`:
   - Test ping/pong exchange
   - Test missed heartbeat counting
   - Test failure detection threshold
   - Test peer addition/removal

2. [ ] Create `examples/heartbeat_failure_detection.ts`:
   - Three-node cluster
   - Demonstrate normal heartbeating
   - Simulate node failure
   - Show failure detection and cleanup

3. [ ] Checkpoint: All tests pass, example runs successfully

## Testing Strategy

### Unit Tests

- [ ] HeartbeatManager sends pings at configured interval
- [ ] HeartbeatManager handles pong responses correctly
- [ ] Missed heartbeat counter increments on timeout
- [ ] `node_failed` event emitted after `maxMissedHeartbeats`
- [ ] New peers are added to heartbeat tracking
- [ ] Departed peers are removed from tracking
- [ ] Disabled heartbeat (enabled: false) does nothing

### Integration Tests

- [ ] Two-node cluster with heartbeat detects simulated failure
- [ ] Heartbeat failure triggers `handleNodeFailure()` cleanup
- [ ] Graceful shutdown doesn't trigger false failure detection
- [ ] Ping staggering distributes load evenly across interval

### Manual Verification

- [ ] Run `examples/heartbeat_failure_detection.ts`
- [ ] Verify logs show ping/pong activity
- [ ] Kill a node and verify quick detection (~3 seconds with defaults)

## Edge Cases & Error Handling

| Scenario | Expected Behavior |
|----------|-------------------|
| Transport timeout on ping | Increment missed count, don't crash |
| Peer already removed by gossip | Skip heartbeat, no duplicate `node_failed` |
| HeartbeatManager stopped during ping | Cancel pending pings gracefully |
| Very high peer count | Consider batching or staggering pings |
| Network partition (both sides alive) | Both detect each other as failed |
| Slow pong (arrives after next ping sent) | Accept late pong, reset missed count |

## Open Questions

- [ ] Should heartbeat RTT be exposed for metrics/monitoring?

## Resolved Questions

- **Ping staggering**: Yes, enabled by default via `staggerPings: true`. Pings are spread across the interval (e.g., 10 peers, 1000ms interval → ping one peer every 100ms).
- **Graceful shutdown integration**: Yes, implemented via:
  1. Tracking `isLeaving` flag per peer from `member_leave` events with "leaving" status
  2. Not declaring failure for peers that are gracefully leaving
  3. Proper shutdown order: HeartbeatManager stops before `cluster.leave()`

## Next Steps

After this plan is approved:
1. Create `src/heartbeat.ts` with interfaces and HeartbeatManager skeleton
2. Implement ping/pong RPC handlers
3. Wire into ActorSystem
4. Write tests
5. Create example
