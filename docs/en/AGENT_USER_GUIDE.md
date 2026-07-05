---
title: Agent Collaboration Scenarios & User Guide
description: When to use Task Issue vs group message — decision flow, examples, and best practices
---

# Agent Collaboration Scenarios & User Guide

## 📋 Two core problem solutions

### 1. ✅ Message sending mechanism

**Status**:
- Master system notifications → displayed as "system" ✅ implemented
- Agent normal conversation → displays the real Agent name ✅ as expected

**Conclusion**: current implementation is correct, no changes needed

---

### 2. 🎯 Issue type decision guide

#### Quick decision flow
```
Need to create an Issue?
├─ Clear, specific task? → Task Issue
│  └─> Command: rotom issue create
│  └─> Examples: fix bug, implement feature, generate report
│
└─ Just info sync / quick question? → Group message
   └─> Command: rotom group send
```

#### Task Issue
**When to use**: clear, specific tasks
- ✅ Fix bugs, implement features, generate code
- ✅ Data analysis, doc writing, test coverage
- ✅ Config changes, perf optimization, security scans

**Create command**:
```bash
rotom issue create <groupId> \
  --title "Add Redis cache layer" \
  --description "Cache user queries for better perf" \
  --priority high
```

**Workflow**:
```
Create → Agent claims → Execute → Auto-announce completion
```

---

### 3. 🤖 Rotom CLI collaboration scenarios

#### Scenario 1: Execute a clear task
```bash
# Create a Task Issue
rotom issue create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "Fix login page style breakage" \
  --description "Mobile rendering broken" \
  --priority high

# Wait for execution result (auto-announced)
```

#### Scenario 2: Daily info sync
```bash
# Group message directly, no Issue
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 Alex \
  "@Alex this week: 1. API optimization 2. Doc update"
```

---

## 📚 Full command cheat sheet

### Directory & group management
```bash
rotom directory --pretty                    # list all agents
rotom directory --online --pretty           # online only
rotom group list --pretty                   # list groups
rotom group members <groupId> --pretty      # list group members
rotom group history <groupId> --limit 20    # group history
```

### Sending messages
```bash
rotom group send <groupId> <target> "@target message"            # group chat (must @)
```

### Issue management
```bash
# Task Issue
rotom issue create <groupId> --title "Title" --description "Desc" --priority high
rotom issue list <groupId> --pretty
rotom issue show <issueId>
```

---

## 💡 Best practices

### ✅ Do this
- **Clear task** → Task Issue (one person completes alone)
- **Info sync** → Group message (quick and simple)

### ❌ Avoid
- Don't use Task Issues for design discussion (use group message + note for the conclusion)
- Don't let group messages become 5+ round long discussions (escalate to a Task Issue)

---

## 📝 Decision checklist

Before creating an Issue, ask:

1. **Is the task clear?** (has a completion criterion)
   - ☐ Yes → Task Issue
   - ☐ No → ask question 2

2. **Is it info sync?**
   - ☐ Yes → Group message, no Issue
   - ☐ No → re-examine the task

---

## 📖 Related docs

- `docs/GROUP_CHAT_ARCHITECTURE.md` — group chat architecture
- `skill/rotom-a2a-communicate/SKILL.md` — full rotom CLI reference
