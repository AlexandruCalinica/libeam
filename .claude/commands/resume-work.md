---
description: Bootstrap session context from journal and prepare for work
model: opus
---

# Resume Work

Bootstrap context from the journal and prepare for a new work session.

Optional focus area: **$ARGUMENTS**

## Process

### Step 1: Load project context

1. **Read the latest journal entry** (contains full timeline):
   ```bash
   LATEST=$(ls -1 journal/*.md | grep -v JOURNAL_RULES | sort | tail -1)
   echo "Latest entry: $LATEST"
   ```
   Then read the full file.

2. **Check current git state**:
   ```bash
   git status
   git log --oneline -5
   git branch --show-current
   ```

3. **Run tests** to verify current state:
   ```bash
   npm run test 2>&1 | tail -30
   ```

4. **If $ARGUMENTS provided**, look for related research:
   ```bash
   ls -la .claude/research/ 2>/dev/null || echo "No research directory"
   ```
   Convert `$ARGUMENTS` to kebab-case and check for `.claude/research/<kebab-case>.md`.
   - Example: `actor system` → `.claude/research/actor-system.md`
   
   If the research file exists, read it and incorporate into context.
   If it doesn't exist, note that `/research-codebase $ARGUMENTS` can be run to generate it.

### Step 2: Synthesize context

Present to the user:

```markdown
## Session Context

**Last Session**: [Entry title and date]
**Branch**: [current branch]
**Test Status**: [X/Y passing]

### Project Timeline (from journal)
[Copy the timeline from latest entry - this is the historical context]

### Current State
[Summarize from latest entry's "Current State" section]

### Pending Next Steps
[From latest entry's "Next Steps" section]

### Today's Focus
[If $ARGUMENTS provided, relate it to the next steps]
[If not provided, suggest picking from next steps]

### Related Research
[If research file exists: summarize key findings from .claude/research/<topic>.md]
[If no research: "No research found. Run `/research-codebase <topic>` to generate."]
```

### Step 3: Prepare for work

Ask the user:

```
Ready to continue. What would you like to work on?

Suggested from previous session:
1. [Next step 1 from journal]
2. [Next step 2 from journal]
3. [Next step 3 from journal]

Or describe what you'd like to tackle.
```

## Purpose

This command ensures:
- **Continuity**: You always know what was done before
- **Context**: The full project timeline is loaded
- **Direction**: Previous next steps guide current work
- **Verification**: Tests confirm the codebase is healthy

## Notes

- Always read the FULL latest journal entry (it contains the complete timeline)
- If tests fail, alert the user before proceeding
- If $ARGUMENTS matches a research topic, incorporate that context
- Keep the summary concise - the journal has details if needed
