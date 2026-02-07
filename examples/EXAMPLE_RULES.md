# Example Rules

Guidelines for creating and maintaining examples in this directory.

## Folder Structure

Examples are organized into two categories based on API complexity:

### `examples/high-level/`

High-level examples use the functional API for simpler, more concise code:
- Uses `createSystem()` and `createActor()` functions
- Closure-based actors with implicit state
- Chainable handler registration: `self.call().cast()`
- Best for: Learning the basics, simple use cases, quick prototypes

**Run:** `npx tsx examples/high-level/<name>.ts`

### `examples/low-level/`

Low-level examples use the class-based API for full control:
- Uses `ActorSystem` class and `Actor` class inheritance
- Explicit lifecycle management
- Full access to advanced features (supervision, migration, etc.)
- Best for: Production code, complex scenarios, advanced features

**Run:** `npx tsx examples/low-level/<name>.ts`

## Purpose

Examples serve as:
1. **Living documentation** - Show how features work in practice
2. **Integration tests** - Verify features work end-to-end
3. **Development drivers** - Guide feature implementation with real use cases
4. **Onboarding material** - Help new users understand the library

## Rules

### 1. Examples Must Be Runnable

Every example must execute successfully with:
```bash
# High-level examples
npx tsx examples/high-level/<name>.ts

# Low-level examples
npx tsx examples/low-level/<name>.ts
```

If an example requires external dependencies (e.g., multiple machines, network setup), document the requirements clearly at the top of the file.

### 2. Examples Must Be Self-Contained

Each example should:
- Import only from `../src` (the library) and standard Node.js modules
- Include all necessary setup code
- Clean up resources (shutdown systems, close connections)
- Not depend on other examples

### 3. Examples Must Be Documented

Each example file must include:
- A comment header explaining what the example demonstrates
- Inline comments for non-obvious code
- Console output that shows what's happening
- Expected output description (optional but recommended)

### 4. Naming Convention

```
<feature>_<variant>.ts
```

Examples:
- `chat.ts` - Basic chat application
- `distributed_ping_pong.ts` - Distributed actors example
- `supervision_restart.ts` - Supervision with restart strategy
- `typed_counter.ts` - Typed actors example

### 5. Complexity Progression

Maintain examples at different complexity levels:

| Level | Description | Target Audience |
|-------|-------------|-----------------|
| Basic | Single node, few actors | New users |
| Intermediate | Multiple nodes, supervision | Learning users |
| Advanced | Full distributed setup, real transports | Production users |

### 6. Keep Examples Updated

When a feature changes:
1. Update all affected examples
2. Run examples to verify they still work
3. Update console output if it changed

### 7. Examples Must Be Tested Before Completion

An example is not considered done until it has been:
1. **Actually executed** - Run the example and observe the output
2. **Verified working** - Confirm it produces the expected behavior
3. **Debugged if needed** - Fix any runtime errors before committing

Do not rely solely on type-checking or code review. Many issues (circular references, race conditions, missing initialization) only manifest at runtime.

### 8. Error Handling

Examples should demonstrate proper error handling:
- Show how to handle actor crashes
- Demonstrate supervision strategies where relevant
- Include cleanup in finally blocks or shutdown hooks

### 9. Process Cleanup After Running Examples

When running examples (especially during development/testing), ensure no hanging Node.js processes remain:

```bash
# After running examples, check for hanging processes
ps aux | grep -E "tsx examples/" | grep -v grep

# Kill any remaining processes
pkill -f "tsx examples/"
```

This is particularly important for:
- Examples that use timeouts or intervals
- Distributed examples with multiple nodes
- Examples that may not reach their cleanup code due to errors

## Example Template

### Low-Level Example

```typescript
// examples/low-level/<name>.ts
//
// Demonstrates: <what this example shows>
// Prerequisites: <any setup required>
// Run: npx tsx examples/low-level/<name>.ts

import { Actor, ActorSystem, ... } from "../../src";

// --- Configuration ---
const CONFIG = {
  // Put configurable values here
};

// --- Actor Definitions ---

class MyActor extends Actor {
  // ...
}

// --- Main ---

async function main() {
  console.log("=== <Example Name> ===\n");
  
  // Setup
  // ...
  
  try {
    // Main logic
    // ...
  } finally {
    // Cleanup
    await system.shutdown();
  }
  
  console.log("\n=== Done ===");
}

main().catch(console.error);
```

## Checklist for New Examples

- [ ] File follows naming convention
- [ ] Header comment explains purpose
- [ ] **Actually ran and tested**: `npx ts-node examples/<name>.ts`
- [ ] Produces expected output without errors
- [ ] Cleans up resources on exit
- [ ] Console output is clear and informative
- [ ] No hardcoded values that should be configurable
- [ ] Error cases are handled gracefully

## Current Examples

### Low-Level Examples (Class-Based API)

| File | Level | Demonstrates |
|------|-------|--------------|
| `low-level/typed_actors.ts` | Basic | Type-safe actors with generics |
| `low-level/timers.ts` | Basic | Actor timers (sendAfter, sendInterval, cancelTimer) |
| `low-level/handle_continue.ts` | Basic | Async post-init work with handleContinue |
| `low-level/idle_timeout.ts` | Basic | Idle timeout for inactivity handling |
| `low-level/chat.ts` | Intermediate | Multi-node chat with in-memory transport |
| `low-level/supervision_tree.ts` | Intermediate | Parent-child supervision strategies |
| `low-level/message_stashing.ts` | Intermediate | Deferred message processing |
| `low-level/actor_watching.ts` | Intermediate | Monitoring actor termination |
| `low-level/actor_links.ts` | Intermediate | Bidirectional crash propagation with links |
| `low-level/distributed_watching.ts` | Intermediate | Remote actor watching across nodes |
| `low-level/distributed_linking.ts` | Intermediate | Remote actor linking with crash propagation |
| `low-level/actor_migration.ts` | Intermediate | Actor migration between nodes with state preservation |
| `low-level/distributed_ping_pong.ts` | Advanced | Real distributed actors via ZeroMQ |

### High-Level Examples (Functional API)

| File | Level | Demonstrates |
|------|-------|--------------|
| `high-level/counter.ts` | Basic | Simple counter with functional API |
| `high-level/chat.ts` | Intermediate | Chat application with functional API |
| `high-level/timers.ts` | Basic | Timer scheduling with functional API |
| `high-level/watching.ts` | Intermediate | Actor watching with functional API |
| `high-level/links.ts` | Intermediate | Actor linking with functional API |
| `high-level/supervision.ts` | Intermediate | Supervision with functional API |
| `high-level/idle_timeout.ts` | Basic | Idle timeout with functional API |
| `high-level/handle_continue.ts` | Basic | Async initialization with functional API |
| `high-level/message_stashing.ts` | Intermediate | Message stashing with functional API |
