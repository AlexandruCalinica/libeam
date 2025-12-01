# Entry 12: Distributed Actor References

## Date: 2024-12-01

## Summary

Enhanced the registry system to support full actor location tracking (nodeId + actorId) and added `getActorByName()` for seamless remote actor discovery. Created example rules documentation and a distributed ping-pong example.

## Problem

The original registry only stored `name -> nodeId` mappings, which meant:
1. To get a remote ActorRef, you had to manually construct an ActorId with the instance ID
2. No convenient API to look up actors by name across nodes
3. Tests using the old registry API needed updates

## Solution

### Registry Interface Enhancement

Extended the Registry interface to store complete actor location info:

```typescript
interface ActorLocation {
  nodeId: string;   // The node where the actor resides
  actorId: string;  // The actor's unique instance ID
}

interface Registry {
  register(name: string, nodeId: string, actorId: string): Promise<void>;
  lookup(name: string): Promise<ActorLocation | null>;
  // ... other methods
}
```

### New `getActorByName()` Method

Added a convenient method to ActorSystem for getting remote actor references:

```typescript
// Before: Manual ActorId construction required
const remoteId = new ActorId("node1", "some-uuid", "greeter");
const ref = system.getRef(remoteId);

// After: Simple name-based lookup
const ref = await system.getActorByName("greeter");
if (ref) {
  await ref.call({ type: "greet", name: "World" });
}
```

### Updated Implementations

1. **InMemoryRegistry** - Updated to store `ActorLocation` objects
2. **RegistryGossip** - Now implements `Registry` interface directly, stores actorId in registrations
3. **GossipRegistry** - Updated as pass-through adapter

## Changes Made

### Modified Files
- `src/registry.ts` - Added `ActorLocation` interface, updated method signatures
- `src/in_memory_registry.ts` - Store `ActorLocation` instead of just nodeId
- `src/registry_gossip.ts` - Implements Registry, added actorId to registrations
- `src/gossip_registry.ts` - Updated to match new interface
- `src/actor_system.ts` - Added `getActorByName()`, updated dispatch methods

### New Files
- `examples/EXAMPLE_RULES.md` - Guidelines for creating examples
- `examples/distributed_ping_pong.ts` - Distributed actors example

### Test Updates
- Updated all tests to use new `ActorLocation` return type from `lookup()`
- Changed `registryGossip.start()` to `registryGossip.connect()`

## Usage Examples

### Getting a Remote Actor Reference

```typescript
// On node1: spawn a named actor
const greeter = node1.spawn(GreeterActor, { name: "greeter" });

// On node2: get a reference to the remote actor by name
const remoteGreeter = await node2.getActorByName("greeter");
if (remoteGreeter) {
  // Send messages to the remote actor
  const reply = await remoteGreeter.call({ type: "greet", name: "World" });
  console.log(reply); // "Hello, World!"
}
```

### Distributed Ping-Pong Example

```typescript
// Terminal 1: Start node1 with PingActor
npx ts-node examples/distributed_ping_pong.ts node1

// Terminal 2: Start node2 with PongActor  
npx ts-node examples/distributed_ping_pong.ts node2
```

The PingActor discovers PongActor by name and they exchange messages across nodes via ZeroMQ.

## Example Rules Document

Created `examples/EXAMPLE_RULES.md` with guidelines:
- Examples must be runnable (`npx ts-node examples/<name>.ts`)
- Examples must be self-contained
- Examples must be documented with headers and inline comments
- Naming convention: `<feature>_<variant>.ts`
- Complexity progression from basic to advanced

## Tests

All 86 tests pass after registry interface update.

## API Changes

| Before | After |
|--------|-------|
| `registry.register(name, nodeId)` | `registry.register(name, nodeId, actorId)` |
| `registry.lookup(name)` returns `string \| null` | `registry.lookup(name)` returns `ActorLocation \| null` |
| Manual ActorId construction for remote refs | `system.getActorByName(name)` |
| `registryGossip.start()` | `registryGossip.connect()` |

## Next Steps

Potential future enhancements:
- Cross-node actor watching (receive DOWN messages for remote actors)
- Remote spawn with confirmation
- Automatic peer discovery
- Leader election / singleton actors
