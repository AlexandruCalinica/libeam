# Entry 13: Core OTP Features

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
- **Entry 13 (Current)**: Core OTP features - timers, handleContinue, links, idle timeout

## Current State

### Test Status: 121 tests passing

### New Features Implemented

1. **Actor Timers** (`src/actor.ts`, `src/actor_system.ts`)
   - `sendAfter(message, delayMs)` - One-shot delayed message
   - `sendInterval(message, intervalMs)` - Repeating messages
   - `cancelTimer(timerRef)` - Cancel a specific timer
   - `cancelAllTimers()` - Cancel all timers (useful in terminate)
   - TimerRef class for timer identification

2. **handleContinue** (`src/actor.ts`, `src/actor_system.ts`)
   - `init()` can return `{ continue: data }` to signal async work
   - `handleContinue(data)` called after init completes
   - Allows spawn() to return immediately while actor initializes async
   - `InitContinue<T>` interface and `isInitContinue()` type guard

3. **Actor Links** (`src/actor.ts`, `src/actor_system.ts`, `src/supervisor.ts`)
   - `link(actorRef)` - Bidirectional crash propagation
   - `unlink(linkRef)` - Remove link
   - `setTrapExit(true)` - Receive ExitMessage instead of crashing
   - `isTrapExit()` - Check trap status
   - LinkRef class, ExitMessage interface
   - Links cleaned up before crash propagation to prevent infinite loops

4. **Idle Timeout** (`src/actor.ts`, `src/actor_system.ts`)
   - `setIdleTimeout(ms)` - Set timeout (0 to disable)
   - `getIdleTimeout()` - Get current timeout
   - TimeoutMessage delivered via handleInfo()
   - Timeout resets on every message processed
   - Recurring - fires again after each idle period

### Key Files Modified

| File | Changes |
|------|---------|
| `src/actor.ts` | Added TimerRef, LinkRef, TimerEntry, ExitMessage, TimeoutMessage, InitContinue; new Actor methods |
| `src/actor_system.ts` | Timer management, link management, idle timeout management, context initialization |
| `src/supervisor.ts` | Link notification on crash |
| `src/child_supervisor.ts` | Link notification on child crash |

### New Test Files

- `test/timers.test.ts` - 9 tests
- `test/handle_continue.test.ts` - 7 tests
- `test/actor_links.test.ts` - 10 tests
- `test/idle_timeout.test.ts` - 9 tests

### New Examples

| File | Demonstrates |
|------|--------------|
| `examples/timers.ts` | Heartbeat, reminders, debounce, request timeouts |
| `examples/handle_continue.ts` | Async init, parallel loading, conditional continue |
| `examples/actor_links.ts` | Crash propagation, unlink, trapExit, bidirectional |
| `examples/idle_timeout.ts` | Cache cleanup, session expiry, connection pruning, self-stop |

## Work Done This Session

### 1. Actor Timers
- Added `TimerRef` class and `TimerEntry` interface
- Implemented `sendAfter()`, `sendInterval()`, `cancelTimer()`, `cancelAllTimers()`
- Timer messages delivered via `handleCast()`
- Timers automatically cleaned up on actor termination

### 2. handleContinue
- Added `InitContinue<T>` interface and type guard
- Modified `spawn()` and `spawnChild()` to check for continue signal
- `handleContinue()` runs asynchronously after init
- Errors in handleContinue trigger supervisor

### 3. Actor Links
- Added `LinkRef`, `ExitMessage` types
- Implemented bidirectional linking in ActorSystem
- Key insight: Must unlink BEFORE propagating crash to prevent infinite loop
- trapExit delivers ExitMessage via handleInfo() instead of crashing

### 4. Idle Timeout
- Added `TimeoutMessage` interface
- Implemented idle tracking in ActorContext (idleTimeout, lastActivityTime, idleTimeoutHandle)
- Reset timeout on every message in processMailbox
- Timeout fires repeatedly while actor remains idle

### 5. Examples
- Created comprehensive examples for all four features
- All examples follow EXAMPLE_RULES.md guidelines
- All examples tested and working

## Architecture Notes

### Timer Flow
```
Actor.sendAfter(msg, delay)
  -> ActorSystem.startActorTimer()
    -> setTimeout/setInterval
      -> dispatchCast(actorRef, msg)
        -> handleCast(msg)
```

### Link Crash Flow
```
Actor A crashes
  -> Supervisor.handleCrash(A)
    -> ActorSystem.notifyLinkedActors(A, reason)
      -> For each linked actor B:
        -> unlink(A, B)  // FIRST to prevent infinite loop
        -> if B.trapExit: sendExitMessage(B)
        -> else: Supervisor.handleCrash(B)
```

### Idle Timeout Flow
```
setIdleTimeout(ms)
  -> _scheduleIdleTimeout()
    -> setTimeout(ms)
      -> if still idle: handleInfo(TimeoutMessage)
      -> reschedule for next period

processMailbox()
  -> _resetIdleTimeout()  // resets lastActivityTime
```

## Next Steps

1. **Persistence** - Event sourcing / snapshotting for actor state
2. **Distributed Links** - Links across nodes (requires transport layer changes)
3. **Process Registry** - Global process registry with gossip
4. **Behaviors** - GenServer-like behavior modules
5. **Distributed Supervision** - Cross-node supervisor trees

## Commits This Session

1. `Implement actor timers (sendAfter, sendInterval, cancelTimer)`
2. `Implement handleContinue for async post-init work`
3. `Implement actor links (bidirectional crash propagation)`
4. `Implement actor idle timeout`
5. `Add examples for new OTP features`
