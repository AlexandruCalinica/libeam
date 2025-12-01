# Typed Actors Implementation

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
- [Entry 9]: Implemented message stashing for deferred message processing
- [Current]: Implemented typed actors with compile-time message type safety

## 2. Current State

### Components
- **TypedActor<TCast, TCall, TReply>**: Base class for type-safe actors
- **TypedActorRef<TCast, TCall, TReply>**: Type-safe reference with message constraints
- **ActorSystem.spawnTyped()**: Factory method for typed actor refs

### Test Status
- **86 tests passing** (9 new typed actor tests)
- All previous tests continue to pass

### Key Files Modified
- `src/actor.ts`: Added `TypedActorRef`, `TypedActor` classes
- `src/actor_system.ts`: Added `spawnTyped()` method
- `test/typed_actors.test.ts`: New test file for typed actors

## 3. Work Done This Session

### TypedActorRef Class
```typescript
class TypedActorRef<TCast, TCall, TReply> {
  constructor(id: ActorId, system: ActorSystem);

  // Type-safe call - message and return type checked at compile time
  call(message: TCall, timeout?: number): Promise<TReply>;

  // Type-safe cast - message type checked at compile time
  cast(message: TCast): void;

  // Convert to untyped ActorRef (for watching, supervision, etc.)
  toUntyped(): ActorRef;
}
```

### TypedActor Base Class
```typescript
abstract class TypedActor<TCast, TCall, TReply> extends Actor {
  // Get typed reference to self
  get typedSelf(): TypedActorRef<TCast, TCall, TReply>;

  // Override these with type-safe handlers
  abstract handleTypedCast(message: TCast): void | Promise<void>;
  abstract handleTypedCall(message: TCall): TReply | Promise<TReply>;

  // Spawn typed child actors
  protected spawnTyped<ChildCast, ChildCall, ChildReply>(
    actorClass: new () => TypedActor<ChildCast, ChildCall, ChildReply>,
    options?: SpawnOptions,
  ): TypedActorRef<ChildCast, ChildCall, ChildReply>;
}
```

### ActorSystem Method
```typescript
// Spawn a typed actor and get a typed reference
spawnTyped<TCast, TCall, TReply>(
  actorClass: new () => TypedActor<TCast, TCall, TReply>,
  options?: SpawnOptions,
): TypedActorRef<TCast, TCall, TReply>;
```

### Example Usage
```typescript
// Define message protocols using discriminated unions
type CounterCast =
  | { type: "increment" }
  | { type: "decrement" }
  | { type: "add"; amount: number };

type CounterCall = { type: "get" } | { type: "getAndReset" };
type CounterReply = number;

// Implement typed actor
class CounterActor extends TypedActor<CounterCast, CounterCall, CounterReply> {
  private count = 0;

  handleTypedCast(message: CounterCast): void {
    switch (message.type) {
      case "increment": this.count++; break;
      case "decrement": this.count--; break;
      case "add": this.count += message.amount; break;
    }
  }

  handleTypedCall(message: CounterCall): CounterReply {
    switch (message.type) {
      case "get": return this.count;
      case "getAndReset":
        const v = this.count;
        this.count = 0;
        return v;
    }
  }
}

// Usage - all type-checked at compile time!
const counter = system.spawnTyped(CounterActor);

counter.cast({ type: "increment" });      // OK
counter.cast({ type: "add", amount: 5 }); // OK
counter.cast({ type: "invalid" });        // Compile error!
counter.cast({ amount: 5 });              // Compile error! Missing 'type'

const value: number = await counter.call({ type: "get" }); // Return type inferred
```

### Tests Added
1. Type-safe cast messages
2. Type-safe call messages with typed returns
3. Convert to untyped ActorRef
4. Async call handlers
5. Cast message handling
6. typedSelf reference
7. Spawn typed children with spawnTyped
8. Discriminated unions
9. Multiple typed actors of different types

## 4. Next Steps

### Priority
1. **Timers** - Scheduled messages with `sendAfter()` / `repeatEvery()`
2. **Behaviors** - Dynamic message handler switching (become/unbecome)
3. **Ask pattern** - Request-reply between actors with typed responses

### Future Considerations
- Protocol validation at runtime (development mode)
- Auto-generated protocol documentation
- Protocol versioning for remote actors

## 5. Architecture Notes

### Type Flow
```
                    Compile Time                         Runtime
                    ============                         =======

TypedActorRef<C,Q,R>                                  ActorRef
       │                                                  │
       │ cast(message: C)                                 │ cast(message: any)
       │ call(message: Q): Promise<R>                     │ call(message: any): Promise<any>
       │                                                  │
       ▼                                                  ▼
TypedActor<C,Q,R>                                      Actor
       │                                                  │
       │ handleTypedCast(message: C)                      │ handleCast(message: any)
       │ handleTypedCall(message: Q): R                   │ handleCall(message: any): any
       │                                                  │
       └──────────────► delegates to ►────────────────────┘
```

### Design Decisions

1. **Extends Actor**: TypedActor extends the base Actor class, maintaining compatibility with all existing features (supervision, watching, stashing, etc.)

2. **Three Type Parameters**: `TCast`, `TCall`, `TReply` - covers fire-and-forget messages, request-reply messages, and reply types separately.

3. **Discriminated Unions**: Recommended pattern for message types - provides exhaustive checking in switch statements.

4. **toUntyped()**: Allows typed refs to work with APIs expecting untyped ActorRef (watching, supervision trees).

5. **Runtime Transparency**: No runtime overhead - types are erased at compile time. The actual message passing is identical to untyped actors.

### Interoperability
| Feature | Works with TypedActor? |
|---------|----------------------|
| Supervision | Yes (extends Actor) |
| Watching | Yes (via toUntyped()) |
| Stashing | Yes (inherited) |
| Child spawning | Yes (spawnTyped method) |
| Remote actors | Yes (same wire format) |
