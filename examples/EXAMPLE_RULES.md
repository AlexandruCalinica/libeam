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

### 7. Error Handling

Examples should demonstrate proper error handling:
- Show how to handle actor crashes
- Demonstrate supervision strategies where relevant
- Include cleanup in finally blocks or shutdown hooks

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
- [ ] Runs without errors: `npx ts-node examples/<name>.ts`
- [ ] Cleans up resources on exit
- [ ] Console output is clear and informative
- [ ] No hardcoded values that should be configurable
- [ ] Error cases are handled gracefully

## Current Examples

| File | Level | Demonstrates |
|------|-------|--------------|
| `chat.ts` | Intermediate | Multi-node chat with in-memory transport |
| `distributed_ping_pong.ts` | Advanced | Real distributed actors via ZeroMQ |

## Planned Examples

| File | Level | Demonstrates |
|------|-------|--------------|
| `typed_actors.ts` | Basic | Type-safe actors with generics |
| `supervision_tree.ts` | Intermediate | Parent-child supervision strategies |
| `message_stashing.ts` | Intermediate | Deferred message processing |
| `actor_watching.ts` | Intermediate | Monitoring actor termination |
