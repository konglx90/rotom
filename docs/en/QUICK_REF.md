---
title: Quick Reference
description: rotom CLI quick reference — Issue / collab / group message cheat sheet
---

# Rotom CLI Quick Reference

## Issue type cheat sheet

| Scenario | Type | Command | Example |
|----------|------|---------|---------|
| Clear task, self-contained | Task | `rotom issue create` | Fix a bug, generate code |
| Info sync, quick Q&A | Group message | `rotom group send` | Progress sync, simple question |

## Scenario examples

### Scenario 1: Execute a clear task
```bash
# Not a discussion — actual work
rotom issue create <groupId> --title "Fix login bug" --description "..."
```

### Scenario 2: Daily communication
```bash
# Simple sync, no Issue created
rotom group send <groupId> <target> "@target is progress on track?"
```

## Decision flow

```
Need to create an Issue?
├─ Clear task? → Task Issue
└─ Info sync?  → Group message, no Issue
```
