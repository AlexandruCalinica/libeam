# Entry 19: Heartbeat Protocol

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
- **Entry 18**: Plan - Heartbeat Protocol
- **Entry 19 (Current)**: Heartbeat Protocol

## Current State

### All Tests Passing

All 167 tests pass (18 new heartbeat tests). All examples run successfully including the new heartbeat failure detection example.

### Features Complete

Heartbeat protocol is now fully implemented with:
- Active failure detection via ping/pong messages over RPC transport
- Configurable timing (interval, timeout, max missed heartbeats)
- Ping staggering to avoid network bursts in large clusters
- Graceful shutdown integration (no false positives for "leaving" peers)
- Automatic integration with `handleNodeFailure()` for cleanup

## Architecture

### Protocol Design

```
Node A                                    Node B
┌─────────────────────────────────────┐   ┌─────────────────────────────────────┐
│  ActorSystem                        │   │  ActorSystem                        │
│       │                             │   │       │                             │
│  HeartbeatManager                   │   │  HeartbeatManager                   │
│       │                             │   │       │                             │
│  heartbeatLoop()                    │   │                                     │
│       │                             │   │                                     │
│       ▼                             │   │                                     │
│  pingPeer("nodeB")                  │   │                                     │
│       │         "heartbeat:ping"    │   │                                     │
│       │  ──────────────────────────►│   │  _handleRpcCall()                   │
│       │                             │   │       │                             │
│       │                             │   │       ▼                             │
│       │                             │   │  heartbeatManager.handlePing()      │
│       │         "heartbeat:pong"    │   │       │                             │
│       │  ◄──────────────────────────│   │       │                             │
│       │                             │   │                                     │
│       ▼                             │   │                                     │
│  reset missedCount                  │   │                                     │
│                                     │   │                                     │
│  [If timeout × 3]                   │   │                                     │
│       │                             │   │                                     │
│       ▼                             │   │                                     │
│  emit('node_failed')                │   │                                     │
│       │                             │   │                                     │
│       ▼                             │   │                                     │
│  handleNodeFailure()                │   │                                     │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
```

### Configuration

```typescript
interface HeartbeatConfig {
  enabled: boolean;           // Enable/disable (default: true)
  intervalMs: number;         // Ping interval (default: 1000ms)
  timeoutMs: number;          // Pong timeout (default: 2000ms)
  maxMissedHeartbeats: number; // Failures before dead (default: 3)
  staggerPings: boolean;      // Spread pings over interval (default: true)
}
```

### RPC Message Types

```typescript
// Ping request
type HeartbeatPing = {
  type: "heartbeat:ping";
  timestamp: number;
  senderId: string;
};

// Pong response
type HeartbeatPong = {
  type: "heartbeat:pong";
  timestamp: number;  // Echo for RTT calculation
  responderId: string;
};
```

## Key Implementation Details

### HeartbeatManager Class

New class in `src/heartbeat.ts`:
- Extends EventEmitter for `node_failed` events
- Tracks `PeerHeartbeatState` per peer (missedCount, pendingPing, isLeaving)
- Listens to cluster `member_join`/`member_leave` events
- Handles both string nodeIds and ClusterPeer objects from events

### Ping Staggering

For large clusters, pings are spread across the interval:
```typescript
if (staggerPings && peers.length > 1) {
  const staggerDelayMs = intervalMs / peers.length;
  peers.forEach((peer, index) => {
    setTimeout(() => pingPeer(peer), index * staggerDelayMs);
  });
}
```
Example: 10 peers, 1000ms interval → ping one peer every 100ms

### Graceful Shutdown Integration

When a peer leaves gracefully (gossip status: "leaving"):
1. HeartbeatManager marks peer as `isLeaving = true`
2. Peer is removed from tracking without emitting `node_failed`
3. No false positive failure detection

Shutdown order is important:
1. `HeartbeatManager.stop()` - stop sending pings
2. `cluster.leave()` - broadcast "leaving" status
3. `transport.disconnect()` - close sockets

### ActorSystem Integration

- HeartbeatManager created in constructor with optional config
- `node_failed` event wired to `handleNodeFailure()`
- Ping handler added to `_handleRpcCall()`
- HeartbeatManager stopped before mailbox draining in `shutdown()`

## Cluster Interface Extension

Extended `src/cluster.ts` to support heartbeat needs:

```typescript
interface Cluster {
  readonly nodeId: string;
  getMembers(): string[];
  getLivePeers?(): ClusterPeer[];  // Optional, with status info
  on?(event: string, listener: (...args: any[]) => void): this;
  removeListener?(event: string, listener: (...args: any[]) => void): this;
}

interface ClusterPeer {
  id: string;
  status?: string;  // "alive" | "leaving" | "dead"
}
```

## Files Modified

| File | Changes |
|------|---------|
| `src/heartbeat.ts` | **New file** - HeartbeatManager, HeartbeatConfig, message types |
| `src/cluster.ts` | Added ClusterPeer interface, optional event methods, getLivePeers |
| `src/actor_system.ts` | Import HeartbeatManager; store cluster; create HeartbeatManager in constructor; wire node_failed event; add ping handler to _handleRpcCall; stop heartbeat in shutdown |
| `src/index.ts` | Export heartbeat module |
| `test/heartbeat.test.ts` | **New file** - 18 tests for heartbeat protocol |
| `examples/heartbeat_failure_detection.ts` | **New file** - Demo of heartbeat features |

## Test Coverage

18 new tests in `test/heartbeat.test.ts`:
- Configuration (defaults, custom, disabled)
- Lifecycle (start, stop, idempotency)
- Ping/pong (handle ping, send to peers, staggering)
- Failure detection (missed heartbeats, reset on pong)
- Peer lifecycle (join, leave, graceful leave)
- Edge cases (no peers, don't ping self, cleanup on stop)

## Example Output

```
=== Heartbeat Failure Detection Demo ===

Starting heartbeat manager (interval=200ms, timeout=150ms, maxMissed=3)

--- Demo 1: Normal Heartbeat Operation ---
  Three nodes started with heartbeat enabled.
  All nodes healthy - no failures detected.

--- Demo 2: Understanding Failure Detection ---
  In a real distributed system, when node3 crashes:
  1. Heartbeat pings to node3 would timeout (no pong response)
  2. After 3 missed heartbeats (600ms), node3 is declared failed
  3. handleNodeFailure() is called to clean up watches/links/children
  4. Gossip protocol would also detect via its timeout mechanism

--- Demo 3: Graceful Shutdown ---
  Shutting down node2 gracefully...
  Node2 shut down gracefully - no false failure triggered.

Key Takeaways:
1. Heartbeat provides ACTIVE failure detection (ping/pong over RPC)
2. Complements PASSIVE gossip-based detection (UDP timeout)
3. Configurable timing for detection speed vs network overhead
4. Graceful shutdown uses 'leaving' status to avoid false positives
5. Detection time = intervalMs * maxMissedHeartbeats
```

## Heartbeat vs Gossip Comparison

| Aspect | Heartbeat | Gossip |
|--------|-----------|--------|
| **Type** | Active (ping/pong) | Passive (timeout) |
| **Transport** | RPC (ZeroMQ) | UDP |
| **Detection Time** | interval × maxMissed | failureTimeoutMs |
| **Default** | 3 seconds | Configurable |
| **Verifies** | RPC connectivity | UDP connectivity |
| **Overhead** | Higher (per-peer pings) | Lower (random fanout) |

## Next Steps

1. **Actor Migration** - Move actors between nodes
2. **Distributed GenServer** - Higher-level abstraction for distributed actors
3. **Heartbeat Metrics** - Expose RTT for monitoring

## Commits This Session

1. Implement heartbeat protocol for active failure detection
