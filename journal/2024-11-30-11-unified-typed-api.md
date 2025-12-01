# Entry 11: Unified Typed API Refactor

## Date: 2024-11-30

## Summary

Refactored the typed actors implementation to use a single unified API instead of separate `TypedActor`/`TypedActorRef` classes. The `Actor` and `ActorRef` classes now support optional generic type parameters with defaults of `any` for backwards compatibility.

## Problem

The initial typed actors implementation (Entry 10) introduced separate classes:
- `TypedActor<TCast, TCall, TReply>` extending `Actor`
- `TypedActorRef<TCast, TCall, TReply>` extending `ActorRef`
- `spawnTyped()` method in addition to `spawn()`

This duplication was unnecessary and created maintenance burden. The user correctly observed that a single `Actor` class with optional generics would be cleaner.

## Solution

### Approach: Optional Generics with `any` Defaults

Modified the existing classes to accept optional type parameters:

```typescript
// ActorRef with optional type parameters (defaults to any)
class ActorRef<TCast = any, TCall = any, TReply = any> {
  call(message: TCall, timeout?: number): Promise<TReply>;
  cast(message: TCast): void;
}

// Actor with optional type parameters (defaults to any)
abstract class Actor<TCast = any, TCall = any, TReply = any> {
  handleCast(message: TCast): void | Promise<void>;
  handleCall(message: TCall): TReply | Promise<TReply>;
}
```

### Key Design Decision: No Type Inference from spawn()

Initially attempted to make `spawn()` infer types from the actor class:
```typescript
spawn<TCast, TCall, TReply, T extends Actor<TCast, TCall, TReply>>(
  actorClass: new () => T
): ActorRef<TCast, TCall, TReply>
```

This failed because TypeScript cannot extract generic type parameters from a class that extends `Actor<X, Y, Z>`. When you call `spawn(CounterActor)`, TypeScript cannot infer `TCast`, `TCall`, `TReply` - they become `unknown`.

The solution was to keep `spawn()` simple:
```typescript
spawn<T extends Actor>(
  actorClass: new () => T
): ActorRef  // Returns ActorRef<any, any, any>
```

Type safety is achieved through explicit annotation:
```typescript
// Untyped (backwards compatible) - no assertions needed
const ref = system.spawn(MyActor);
await ref.call({ anything: true });  // returns any

// Typed (opt-in via annotation)
const counter: ActorRef<CounterCast, CounterCall, CounterReply> = system.spawn(CounterActor);
await counter.call({ type: "get" });  // returns CounterReply
```

## Changes Made

### Removed
- `TypedActorRef` class
- `TypedActor` class
- `spawnTyped()` method from ActorSystem

### Modified
- `ActorRef` - added generic type parameters with `any` defaults
- `Actor` - added generic type parameters with `any` defaults
- `ActorSystem.spawn()` - simplified signature, returns `ActorRef`
- `Actor.spawn()` - simplified signature for child spawning
- Updated typed_actors.test.ts to use unified API

### Exports
Updated `src/index.ts` to remove `TypedActor` and `TypedActorRef` exports.

## Usage Examples

### Untyped Actor (unchanged from before)
```typescript
class SimpleActor extends Actor {
  handleCast(message: any): void {
    console.log(message);
  }
  handleCall(message: any): any {
    return { received: message };
  }
}

const ref = system.spawn(SimpleActor);
ref.cast({ type: "hello" });
const result = await ref.call({ type: "ping" });
```

### Typed Actor (cleaner than before)
```typescript
type CounterCast = { type: "increment" } | { type: "decrement" };
type CounterCall = { type: "get" };
type CounterReply = number;

class CounterActor extends Actor<CounterCast, CounterCall, CounterReply> {
  private count = 0;

  handleCast(message: CounterCast): void {
    if (message.type === "increment") this.count++;
    else this.count--;
  }

  handleCall(message: CounterCall): CounterReply {
    return this.count;
  }
}

// Type annotation provides compile-time safety
const counter: ActorRef<CounterCast, CounterCall, CounterReply> = system.spawn(CounterActor);
counter.cast({ type: "increment" });  // Type-checked
const value = await counter.call({ type: "get" });  // value: number
```

## Tests

All 86 tests pass:
- 9 typed actor tests updated to use unified API
- All existing tests continue to work without modification

## Lessons Learned

1. **TypeScript generic inference has limits** - You cannot extract type parameters from a class extending a generic base at the call site.

2. **Simple defaults beat complex inference** - Using `any` defaults and letting users opt-in to type safety via annotations is cleaner than trying to force type inference.

3. **Avoid unnecessary class duplication** - A single class with optional generics is better than two classes doing the same thing.

## Next Steps

Potential future enhancements:
- Distributed actor references (cross-node communication)
- Actor persistence/event sourcing
- Backpressure mechanisms for mailboxes
- Metrics and observability
