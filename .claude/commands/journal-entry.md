---
description: Write a journal entry documenting the current session's work
model: opus
---

# Write Journal Entry

Create a journal entry documenting the work done this session.

Topic/Title hint: **$ARGUMENTS**

## Process

### Step 1: Gather context

1. **Read JOURNAL_RULES.md**:
   ```
   Read journal/JOURNAL_RULES.md
   ```

2. **List existing entries** to build the timeline:
   ```bash
   ls -1 journal/*.md | grep -v JOURNAL_RULES | sort
   ```

3. **Read the most recent entry** to understand current state:
   ```bash
   ls -1 journal/*.md | grep -v JOURNAL_RULES | sort | tail -1
   ```
   Then read that file.

4. **Get git information**:
   ```bash
   git log --oneline -10  # Recent commits this session
   git diff --stat HEAD~5  # Files changed recently
   git branch --show-current
   ```

5. **Check for research documents** used this session:
   ```bash
   ls -la .claude/research/ 2>/dev/null
   ```
   If research was generated/used during this session, note it for the entry.

6. **Check test status**:
   ```bash
   npm run test 2>&1 | tail -20
   ```

### Step 2: Determine entry number

From the listing, find today's date entries and determine the next sequence number:
- If no entries today: `YYYY-MM-DD-01-description.md`
- If entries exist: increment the sequence number

### Step 3: Write the entry

Create `journal/YYYY-MM-DD-NN-$ARGUMENTS.md` following JOURNAL_RULES.md structure:

```markdown
# Entry NN: [Title from $ARGUMENTS or inferred]

## Project Timeline

[Build from previous entry's timeline + add current work]
- **Entry 1**: [from history]
- **Entry 2**: [from history]
- ...
- **Entry NN (Current)**: [This session's focus]

## Current State

### Test Status
[X/Y tests passing - from actual test run]

### Components Status
[What's working, what's new, what changed]

## Work Done This Session

### [Main accomplishment 1]
- What was implemented
- Key files modified with line references
- Decisions made and why

### [Main accomplishment 2]
...

## Key Implementation Details

[Important technical details for future reference]
- Code patterns used
- Architecture decisions
- Non-obvious implementation choices

## Files Modified

| File | Changes |
|------|---------|
| `src/file.ts` | Added X, modified Y |

## Research Used
[If research docs were referenced: `.claude/research/<topic>.md` - brief note on how it helped]
[If none: omit this section]

## Next Steps

1. [Concrete next action]
2. [Another action]
3. [Known issues to address]

## Commits This Session

[List commits from git log that are part of this session]
```

### Step 4: Verify and present

- Ensure the timeline is complete (every previous entry mentioned)
- Keep it concise (~100-200 lines)
- Show the user the entry path and a summary

## Rules

- **Timeline is sacred**: Every entry must have the complete project timeline
- **Be specific**: Include file:line references, actual test counts, real commit hashes
- **Stay concise**: Target 100-200 lines max
- **No fluff**: Document what was done, not what might be done
- **Use $ARGUMENTS**: If provided, use it as the entry title/focus
