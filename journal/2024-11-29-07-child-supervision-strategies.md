# Child Supervision Strategies Implementation

## 1. Historical Summary

### Project Timeline
- [Entry 1]: Completed decentralized registry with gossip protocol, vector clocks, ZeroMQ transport
- [Entry 2]: Cleanup and ZeroMQ test fixes
- [Entry 3]: Implemented graceful shutdown for ActorSystem and GossipProtocol
- [Entry 4]: Added structured logging system and custom error types
- [Entry 5]: Implemented health check system with HealthAggregator
- [Entry 6]: Implemented actor supervision trees with parent-child relationships
- [Current]: Added child supervision strategies (one-for-one, one-for-all, rest-for-one)

## 2. Current State

### Components
- **ActorSystem**: Full supervision tree support with child supervision strategies
- **Actor**: `childSupervision()` method for defining restart strategies
- **ChildSupervisor**: New class handling child crash recovery with different strategies
- **Supervisor**: Updated to delegate child crashes to ChildSupervisor

### Test Status
- **61 tests passing** (7 new child supervision strategy tests)
- All previous tests continue to pass

### Key Files
- `src/actor.ts`: Added `ChildSupervisionStrategy`, `ChildSupervisionOptions`, `childSupervision()` method
- `src/child_supervisor.ts`: New file implementing supervision strategies
- `src/actor_system.ts`: Added `stopSingle()`, updated `restart()` for child actors
- `src/supervisor.ts`: Delegates child crashes to ChildSupervisor
- `test/child_supervision.test.ts`: New test file for supervision strategies

## 3. Work Done This Session

### New Types and Interfaces
```typescript
type ChildSupervisionStrategy = "one-for-one" | "one-for-all" | "rest-for-one";

interface ChildSupervisionOptions {
  strategy: ChildSupervisionStrategy;
  maxRestarts: number;
  periodMs: number;
}
```

### Actor Changes
- Added `childSupervision()` method that actors override to define strategy
- Added `childOrder: ActorRef[]` to `ActorContext` for tracking spawn order
- Default: one-for-one with 3 restarts in 5 seconds

### ChildSupervisor Class
Implements three OTP-style supervision strategies:
- **one-for-one**: Only restart the crashed child
- **one-for-all**: Stop all children, restart all in original order
- **rest-for-one**: Restart crashed child and all children spawned after it

### Restart Tracking
- Uses stable key (`parentId:childName` or `parentId:args`) to track restarts
- Survives across actor ID changes during restarts
- Respects `maxRestarts` and `periodMs` limits

### Integration
- `Supervisor.handleCrash()` checks for parent metadata
- Child crashes delegated to `ChildSupervisor.handleChildCrash()`
- Root actor crashes handled by original `Supervisor`

### Tests Added
1. one-for-one: only restarts crashed child
2. one-for-all: restarts all children
3. one-for-all: maintains original spawn order
4. rest-for-one: restarts crashed + later children
5. rest-for-one: only crashes last = only restarts last
6. rest-for-one: first crashes = restarts all
7. max restarts exceeded = child stopped

## 4. Next Steps

### Priority
1. **Actor watching** - Allow actors to monitor other actors for termination
2. **Message stashing** - Defer messages during initialization/transitions
3. **Typed actors** - Add TypeScript generics for message types

### Future Considerations
- Supervisor directive responses (restart, stop, escalate)
- Dynamic supervision (add/remove children at runtime)
- Supervision tree visualization/debugging tools

## 5. Architecture Notes

### Supervision Flow
```
Actor crashes in handleCast/handleCall
           │
           ▼
    Supervisor.handleCrash()
           │
           ├─ Has parent? ──Yes──► ChildSupervisor.handleChildCrash()
           │                              │
           │                              ├─ Check restart limits
           │                              │
           │                              ├─ Apply strategy:
           │                              │   - one-for-one: restart(crashed)
           │                              │   - one-for-all: stop all, spawn all
           │                              │   - rest-for-one: stop crashed+later, spawn
           │                              │
           │                              └─ Exceeded limits? Stop permanently
           │
           └─ No parent ──► Handle as root actor (existing logic)
```

### Restart Key Strategy
To track restarts across actor ID changes:
```
restartKey = parentId + ":" + (childName || JSON.stringify(args))
```
This ensures that restarted actors share the same restart counter.
