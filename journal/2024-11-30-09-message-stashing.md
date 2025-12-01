# Message Stashing Implementation

## 1. Historical Summary

### Project Timeline
- [Entry 1]: Completed decentralized registry with gossip protocol, vector clocks, ZeroMQ transport
- [Entry 2]: Cleanup and ZeroMQ test fixes
- [Entry 3]: Implemented graceful shutdown for ActorSystem and GossipProtocol
- [Entry 4]: Added structured logging system and custom error types
- [Entry 5]: Implemented health check system with HealthAggregator
- [Entry 6]: Implemented actor supervision trees with parent-child relationships
- [Entry 7]: Added child supervision strategies (one-for-one, one-for-all, rest-for-one)
- [Entry 8]: Implemented actor watching (monitors) for termination notifications
- [Current]: Implemented message stashing for deferred message processing

## 2. Current State

### Components
- **Actor**: `stash()`, `unstashAll()`, `unstash()`, `clearStash()` methods
- **ActorSystem**: Unified mailbox processing for cast and call messages with stash support
- **StashedMessage**: Type representing a deferred message with resolve/reject callbacks

### Test Status
- **77 tests passing** (7 new message stashing tests)
- All previous tests continue to pass

### Key Files Modified
- `src/actor.ts`: Added `StashedMessage` type, stash methods, `currentMessage` tracking
- `src/actor_system.ts`: Updated mailbox processing to support stashing, unified cast/call handling
- `test/message_stashing.test.ts`: New test file for message stashing

## 3. Work Done This Session

### New Types and Interfaces
```typescript
interface StashedMessage {
  type: "cast" | "call";
  message: any;
  /** For call messages, the resolve/reject functions */
  resolve?: (value: any) => void;
  reject?: (error: any) => void;
}
```

### Actor Context Changes
- Added `stash: StashedMessage[]` - Array of stashed messages
- Added `currentMessage?: StashedMessage` - Message currently being processed

### Actor Methods
```typescript
// Stash current message for later processing
protected stash(): void

// Prepend all stashed messages to mailbox (preserves order)
protected unstashAll(): void

// Unstash just the oldest stashed message
protected unstash(): void

// Discard all stashed messages (rejects pending calls)
protected clearStash(): void
```

### ActorSystem Changes
- **Unified mailbox processing**: Both cast and call messages now go through the mailbox
- **Call queueing**: `dispatchCall()` now queues messages instead of directly calling handlers
- **Stash detection**: Checks if message was re-stashed before resolving/rejecting
- **Shutdown rejection**: Calls during shutdown are immediately rejected

### Key Implementation Details

1. **Message Flow**:
   - All messages (cast and call) go through the mailbox
   - `currentMessage` is set before handler is called
   - Handler can call `stash()` to defer the message
   - After handler returns, checks if message was stashed
   - Only resolves/rejects call if message wasn't stashed

2. **Stash Detection**:
   ```typescript
   const wasStashed = actor.context.stash.includes(stashedMessage);
   if (!wasStashed && stashedMessage.resolve) {
     stashedMessage.resolve(result);
   }
   ```

3. **Order Preservation**:
   - `unstashAll()` prepends messages to front of mailbox
   - Messages are processed in original arrival order

### Tests Added
1. Stash cast messages until ready
2. Stash call messages until ready
3. Preserve message order when unstashing
4. State machine stashing (work until processing state)
5. Clear stash discards messages
6. Selective unstash (one at a time)
7. Mixed cast and call message stashing

## 4. Next Steps

### Priority
1. **Typed actors** - Add TypeScript generics for message types
2. **Timers** - Scheduled messages with `sendAfter()` / `repeatEvery()`
3. **Behaviors** - Dynamic message handler switching (become/unbecome)

### Future Considerations
- Bounded stash (prevent memory issues)
- Stash priority/ordering options
- Stash persistence for recovery

## 5. Architecture Notes

### Message Processing Flow
```
Message arrives (cast or call)
         │
         ▼
  Added to mailbox
         │
         ▼
  processMailbox() dequeues message
         │
         ▼
  Set context.currentMessage
         │
         ▼
  Call handleCast() or handleCall()
         │
         ├─ Handler calls stash()
         │      │
         │      └─ Message pushed to context.stash
         │
         └─ Handler returns
                │
                ▼
          Was message stashed?
                │
         ┌──────┴──────┐
         │ Yes         │ No
         │             │
         │             ▼
         │      Resolve/reject call
         │      (if applicable)
         │             │
         └─────────────┘
                │
                ▼
         Clear currentMessage
                │
                ▼
         Schedule next processMailbox()
```

### Unstash Flow
```
Actor calls unstashAll()
         │
         ▼
  Get messages from context.stash
         │
         ▼
  Clear context.stash
         │
         ▼
  system.unstashAll() prepends to mailbox
         │
         ▼
  Messages processed in original order
```

### Use Cases
| Scenario | Solution |
|----------|----------|
| Async initialization | Stash until init completes, then unstashAll |
| State machine | Stash messages invalid for current state |
| Rate limiting | Stash during backpressure, unstash when ready |
| Dependency waiting | Stash until dependent data arrives |
