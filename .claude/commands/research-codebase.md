---
description: Research and document codebase for a specific topic
model: opus
---

# Research Codebase

Research the codebase for: **$ARGUMENTS**

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY
- DO NOT suggest improvements or changes unless explicitly asked
- DO NOT perform root cause analysis unless explicitly asked
- DO NOT propose future enhancements unless explicitly asked
- DO NOT critique the implementation or identify problems
- DO NOT recommend refactoring, optimization, or architectural changes
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Research Process

### Step 1: Analyze the research topic
- Break down "$ARGUMENTS" into composable research areas
- Identify specific components, patterns, or concepts to investigate
- Create a research plan using TodoWrite to track subtasks

### Step 2: Spawn parallel sub-agents for research
Use the Task tool with `subagent_type: "Explore"` to research different aspects concurrently:

```
Task(subagent_type="Explore", prompt="Find and document [specific aspect]. 
Return: file paths, line numbers, and descriptions of what exists.
DO NOT suggest improvements - only document what is there.")
```

Research areas to cover (spawn these in parallel):
- **Core implementations**: Where is the main logic for this topic?
- **Type definitions**: What interfaces/types are relevant?
- **Usage patterns**: How is this used throughout the codebase?
- **Tests**: What test coverage exists? (check `__tests__/` or `*.test.ts`)
- **Dependencies**: What does this depend on? What depends on it?

Remind all sub-agents: Document what IS, not what SHOULD BE.

### Step 3: Wait and synthesize
- Wait for ALL sub-agents to complete before proceeding
- Compile findings from all agents
- Connect findings across different components
- Include specific file paths and line numbers

### Step 4: Generate research document

Create the output directory and file:
```bash
mkdir -p .claude/research
```

**Filename convention**: Convert `$ARGUMENTS` to kebab-case for the filename.
- Example: `actor system` → `.claude/research/actor-system.md`
- Example: `gossip protocol` → `.claude/research/gossip-protocol.md`

Write to `.claude/research/<kebab-case-topic>.md` with this structure:

```markdown
# Research: [Topic]

**Date**: [Current date]
**Git Commit**: [run: git rev-parse --short HEAD]
**Branch**: [run: git branch --show-current]

## Research Question
[The $ARGUMENTS topic]

## Summary
[2-3 sentence high-level documentation of what was found]

## Key Files

| File | Purpose | Lines |
|------|---------|-------|
| `src/file.ts` | Brief description | L10-50 |

## Detailed Findings

### [Component/Area 1]
- What exists at `file.ts:123`
- How it connects to other components
- Current implementation details

### [Component/Area 2]
...

## Type Definitions
[Key interfaces and types with file:line references]

## Usage Patterns
[How this feature/concept is used, with examples from the codebase]

## Dependencies
- **Internal**: What this depends on within the codebase
- **External**: npm packages or external dependencies

## Architecture Notes
[Current patterns and design implementations - descriptive, not prescriptive]

## Open Questions
[Any areas that remain unclear or need further investigation]
```

### Step 5: Present findings
- Show a concise summary to the user
- Include key file references for navigation
- Ask if they need clarification or have follow-up questions

## Compactness Rules
- Use `file:line` references instead of copying large code blocks
- Summarize patterns rather than listing every instance
- Focus on information useful for future implementation tasks
- Keep total output under 500 lines

## Important Notes
- Always use parallel Task agents with `subagent_type: "Explore"` to maximize efficiency
- Focus on concrete file paths and line numbers
- Research documents should be self-contained with all necessary context
- Document cross-component connections and how systems interact
- **CRITICAL**: You and all sub-agents are documentarians, not evaluators
- **REMEMBER**: Document what IS, not what SHOULD BE
