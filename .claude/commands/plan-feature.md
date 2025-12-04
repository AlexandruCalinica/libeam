---
description: Design a feature before implementing - creates a plan in the journal
model: opus
---

# Plan Feature

Design and plan a feature before implementing it.

Feature to plan: **$ARGUMENTS**

## CRITICAL: This is a PLANNING command, not an implementation command
- DO NOT write any implementation code
- DO NOT modify source files
- ONLY produce a plan document in the journal

## Process

### Step 1: Understand context

1. **Read latest journal entry** for current state:
   ```bash
   LATEST=$(ls -1 journal/*.md | grep -v JOURNAL_RULES | sort | tail -1)
   ```
   Read the file to understand what exists.

2. **Check for existing research** on this topic:
   ```bash
   ls -la .claude/research/ 2>/dev/null
   ```
   Convert `$ARGUMENTS` to kebab-case and look for `.claude/research/<kebab-case>.md`.
   - Example: `distributed supervision` → `.claude/research/distributed-supervision.md`
   
   If the research file exists, read it fully - it contains the codebase context needed for planning.

3. **If no research exists**, run `/research-codebase $ARGUMENTS` first, OR spawn a research agent:
   ```
   Task(subagent_type="Explore", prompt="Research '$ARGUMENTS' in this codebase.
   Find: related code, patterns used, integration points, similar implementations.
   Return file paths and line numbers.")
   ```

### Step 2: Analyze requirements

Think through:
- What problem does this feature solve?
- What components need to change?
- What new components are needed?
- How does it integrate with existing architecture?
- What are the edge cases?
- What tests are needed?

### Step 3: Create plan document

Determine entry number and create `journal/YYYY-MM-DD-NN-plan-$ARGUMENTS.md`:

```markdown
# Entry NN: Plan - [Feature Name]

## Project Timeline
[Copy from latest entry + add this planning entry]

## Feature Overview

### Problem Statement
[What problem does this solve? Why is it needed?]

### Goals
- [Concrete goal 1]
- [Concrete goal 2]

### Non-Goals
- [What this feature explicitly won't do]

## Current State Analysis

### Relevant Existing Code
| File | Purpose | Relevance |
|------|---------|-----------|
| `src/file.ts:L50-100` | Description | How it relates |

### Patterns to Follow
[Existing patterns in the codebase that should be followed]

### Integration Points
[Where this feature connects to existing code]

## Proposed Design

### Architecture
```
[ASCII diagram if helpful]
```

### New Components
| Component | Purpose | Location |
|-----------|---------|----------|
| NewThing | Does X | `src/new_thing.ts` |

### Modified Components
| Component | Changes Needed |
|-----------|----------------|
| `src/existing.ts` | Add method X, modify Y |

### Data Structures
```typescript
// Key interfaces/types needed
interface NewInterface {
  // ...
}
```

### Key Algorithms/Logic
[Describe non-obvious logic or algorithms]

## Implementation Plan

### Phase 1: [Foundation]
1. [ ] Step 1 - specific file and change
2. [ ] Step 2
3. [ ] Checkpoint: [What should work after phase 1]

### Phase 2: [Core Feature]
1. [ ] Step 1
2. [ ] Step 2
3. [ ] Checkpoint: [What should work after phase 2]

### Phase 3: [Integration/Polish]
1. [ ] Step 1
2. [ ] Step 2
3. [ ] Checkpoint: [Feature complete]

## Testing Strategy

### Unit Tests
- [ ] Test case 1
- [ ] Test case 2

### Integration Tests
- [ ] Test scenario 1

### Manual Verification
- [ ] How to manually verify it works

## Edge Cases & Error Handling

| Scenario | Expected Behavior |
|----------|-------------------|
| Edge case 1 | Handle by... |
| Error case 1 | Fail with... |

## Open Questions

- [ ] Question 1 that needs answering before/during implementation
- [ ] Question 2

## Next Steps

After this plan is approved:
1. First implementation step
2. Second step
```

### Step 4: Present plan

Show the user:
- Summary of the plan
- The file path created
- Ask for feedback or approval to proceed

## Rules

- **No implementation**: This command only produces plans
- **Be specific**: Include file paths, line numbers, concrete steps
- **Consider existing patterns**: The plan should fit the codebase style
- **Phased approach**: Break work into verifiable checkpoints
- **Testability**: Every feature needs a testing strategy
