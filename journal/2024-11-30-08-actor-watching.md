# Actor Watching Implementation

## 1. Historical Summary

### Project Timeline
- [Entry 1]: Completed decentralized registry with gossip protocol, vector clocks, ZeroMQ transport
- [Entry 2]: Cleanup and ZeroMQ test fixes
- [Entry 3]: Implemented graceful shutdown for ActorSystem and GossipProtocol
- [Entry 4]: Added structured logging system and custom error types
- [Entry 5]: Implemented health check system with HealthAggregator
- [Entry 6]: Implemented actor supervision trees with parent-child relationships
- [Entry 7]: Added child supervision strategies (one-for-one, one-for-all, rest-for-one)
- [Current]: Implemented actor watching (monitors) for termination notifications

## 2. Current State

### Components
- **ActorSystem**: Full watch/unwatch support with watcher tracking
- **Actor**: `watch()`, `unwatch()`, and `handleInfo()` methods for monitoring
- **WatchRef**: Unique identifier for watch relationships
- **DownMessage**: Notification sent when watched actors terminate

### Test Status
- **70 tests passing** (9 new actor watching tests)
- All previous tests continue to pass

### Key Files Modified
- `src/actor.ts`: Added `WatchRef`, `TerminationReason`, `DownMessage`, `InfoMessage` types; `watch()`, `unwatch()`, `handleInfo()` methods
- `src/actor_system.ts`: Added watch tracking maps, `watch()`, `unwatch()`, `notifyWatchers()`, `sendDownMessage()` methods
- `src/supervisor.ts`: Notify watchers on crash/stop with appropriate reason
- `src/child_supervisor.ts`: Notify watchers when child exceeds max restarts
- `test/actor_watching.test.ts`: New test file for actor watching

## 3. Work Done This Session

### New Types and Interfaces
```typescript
class WatchRef {
  constructor(
    public readonly id: string,
    public readonly watcherId: string,
    public readonly watchedId: string,
  ) {}
}

type TerminationReason =
  | { type: "normal" }      // Graceful stop
  | { type: "error"; error: any }  // Crashed with Stop strategy
  | { type: "killed" };     // Exceeded max restarts

interface DownMessage {
  type: "down";
  watchRef: WatchRef;
  actorRef: ActorRef;
  reason: TerminationReason;
}

type InfoMessage = DownMessage;  // Extensible for future system messages
```

### Actor Changes
- Added `handleInfo(message: InfoMessage)` - Override to react to system messages
- Added `watch(actorRef)` - Start monitoring another actor
- Added `unwatch(watchRef)` - Stop monitoring
- Added `watches: Map<string, WatchRef>` to `ActorContext`

### ActorSystem Changes
- `watches: Map<string, WatchEntry>` - All active watch relationships
- `watchedBy: Map<string, Set<string>>` - Reverse index: actor ID -> watching refs
- `watch(watcherRef, watchedRef)` - Create watch, returns WatchRef
- `unwatch(watchRef)` - Remove watch
- `notifyWatchers(actorRef, reason)` - Send DOWN to all watchers
- `sendDownMessage(watchRef, watchedRef, reason)` - Deliver DOWN via handleInfo

### Integration Points
- `stop()` - Notifies watchers with `{ type: "normal" }`
- `stopSingle()` - Optional notification (disabled during restarts)
- `Supervisor.handleCrash()` - Notifies with `{ type: "error" }` or `{ type: "killed" }`
- `ChildSupervisor.handleChildCrash()` - Notifies with `{ type: "killed" }` on max restarts

### Edge Cases Handled
- Watching a dead actor sends immediate DOWN message
- Watcher cleanup when watcher stops (removes all its watches)
- Multiple watchers on same actor all receive notifications
- Watch is one-shot: automatically cleaned up after DOWN is sent

### Tests Added
1. Receive DOWN when watched actor is stopped (normal)
2. Receive DOWN with error reason when actor crashes (Stop strategy)
3. No DOWN after unwatching
4. Immediate DOWN when watching already-dead actor
5. Multiple watchers on same actor
6. Watching multiple actors
7. Clean up watches when watcher stops
8. Killed reason when exceeding max restarts
9. WatchRef included in DOWN message for identification

## 4. Next Steps

### Priority
1. **Message stashing** - Defer messages during initialization/transitions
2. **Typed actors** - Add TypeScript generics for message types
3. **Timers** - Scheduled messages with `sendAfter()` / `repeatEvery()`

### Future Considerations
- Remote actor watching (cross-node monitors)
- Link semantics (bidirectional, crash propagation)
- Process groups / named groups

## 5. Architecture Notes

### Watch Flow
```
Actor A calls watch(B)
         │
         ▼
  ActorSystem.watch()
         │
         ├─ Create WatchRef
         ├─ Store in watches map
         ├─ Add to watchedBy[B]
         ├─ Store in A's context.watches
         │
         └─ If B already dead → sendDownMessage() immediately

Actor B terminates (stop/crash)
         │
         ▼
  notifyWatchers(B, reason)
         │
         ├─ For each watcher in watchedBy[B]:
         │      │
         │      ├─ sendDownMessage()
         │      │      │
         │      │      └─ watcher.handleInfo(DownMessage)
         │      │
         │      └─ unwatch() (cleanup)
         │
         └─ Done
```

### Termination Reasons
| Scenario | Reason Type |
|----------|-------------|
| `system.stop(actor)` | `{ type: "normal" }` |
| Crash with Stop strategy | `{ type: "error", error }` |
| Exceeded max restarts | `{ type: "killed" }` |

### Watch vs Link (Erlang comparison)
- **Watch (monitor)**: One-way, watcher receives notification, watched doesn't know
- **Link**: Bidirectional, both actors affected by crashes (not implemented yet)
