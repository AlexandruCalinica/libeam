# Example Rules

Guidelines for creating and maintaining examples in this directory.

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
npx ts-node examples/<name>.ts
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

```typescript
// examples/<name>.ts
//
// Demonstrates: <what this example shows>
// Prerequisites: <any setup required>
// Run: npx ts-node examples/<name>.ts

import { Actor, ActorSystem, ... } from "../src";

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

| File | Level | Demonstrates |
|------|-------|--------------|
| `typed_actors.ts` | Basic | Type-safe actors with generics |
| `timers.ts` | Basic | Actor timers (sendAfter, sendInterval, cancelTimer) |
| `handle_continue.ts` | Basic | Async post-init work with handleContinue |
| `idle_timeout.ts` | Basic | Idle timeout for inactivity handling |
| `chat.ts` | Intermediate | Multi-node chat with in-memory transport |
| `supervision_tree.ts` | Intermediate | Parent-child supervision strategies |
| `message_stashing.ts` | Intermediate | Deferred message processing |
| `actor_watching.ts` | Intermediate | Monitoring actor termination |
| `actor_links.ts` | Intermediate | Bidirectional crash propagation with links |
| `distributed_watching.ts` | Intermediate | Remote actor watching across nodes |
| `distributed_linking.ts` | Intermediate | Remote actor linking with crash propagation |
| `distributed_ping_pong.ts` | Advanced | Real distributed actors via ZeroMQ |
