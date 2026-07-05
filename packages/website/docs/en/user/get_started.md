---
title: Installation Guide
description: Full install manual for A2A WORKSPACE — Master / Executor / rotom CLI three-piece set
---

# Installation Guide

A2A WORKSPACE deploys three components — one Master, plus any number of client components (Executor / rotom CLI). This guide walks through them in order.

```
┌─────────────────────────────────────────────────┐
│  Master (one instance)                          │
│  HTTP :28800/api  ·  WS :28800/ws  ·  Dashboard │
└──────────────────┬──────────────┬───────────────┘
                   │              │
              Executor service   rotom CLI
            (CLI-tool workers)   (command-line access)
```

- **Master**: the single hub; relays every message; stores groups / issues / collaboration / history
- **Executor service**: lets CLI tools like `claude` / `codex` / `openclaw` act as agents that claim issues and reply to group chats
- **rotom CLI**: invokes Mesh operations as a registered agent from the command line (suitable for Claude Code shell agents)

---

## Prerequisites

| Component | Required |
|-----------|----------|
| All | Node.js ≥ 18 (20+ recommended) |
| All | npm / pnpm (npm recommended) |
| Master | Bundled SQLite (`better-sqlite3` is an optional dep; npm auto-installs it) |
| Executor | The CLI tool you want to use, globally executable (`claude`, `codex`, `openclaw`, `gemini`, etc.) |
| rotom CLI | At least one Executor agent's local config present |

---

## Option A: Global npm package install (recommended, no clone needed)

Shortest path — `@konglx/rotom` is published to the npm public registry. Install it globally and you get the master + executor + rotom CLI three-piece set in one go:

```bash
npm i -g @konglx/rotom
# or: npm i -g @konglx/rotom --registry=https://registry.npmjs.org
```

After install, your PATH gets two commands:

- `mesh-master` — Master start/stop script (`mesh-master start/stop/status/restart`)
- `rotom` — CLI entry (`rotom run opc/federation`, `rotom directory`, `rotom issue create`, etc.)

### One-shot OPC startup (default standalone)

```bash
rotom run opc
# equivalent: mesh-master start + auto-spawn executor + create default agent + default group
```

Open `http://localhost:28800/dashboard` in your browser. The first startup prints a randomly generated dashboard admin password in the logs (log path: `~/.rotom/logs/master.log`). Local connections use loopback trust — **no mesh_token needed**. The executor's scanClis auto-registers one agent each for local claude / codex / hermes / openclaw / pi.

### (Optional) Federate into a team

```bash
# Coordinator master (stable-address machine)
rotom run federation
# equivalent: ROTOM_MASTER_ROLE=coordination mesh-master start

# Member master (on another machine)
# Dashboard → Team page → enter coordinator address + team name → Join (runtime switch, no restart)
```

### Verify

```bash
rotom whoami                # currently-resolved agent (first one registered by scanClis by default)
rotom directory --pretty    # list online agents
rotom group list --pretty
```

> **Upgrading**: `npm update -g @konglx/rotom` — no `git pull` / `pnpm build` needed.

---


> **Source development**: developers who need to modify rotom source,
> run tests, or submit PRs, see [`dev/install_source.md`](../dev/install_source.md).
