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
- **Executor service**: lets CLI tools like `claude` / `codex` act as agents that claim issues and reply to group chats
- **rotom CLI**: invokes Mesh operations as a registered agent from the command line (suitable for Claude Code shell agents)

---

## Prerequisites

| Component | Required |
|-----------|----------|
| All | Node.js ≥ 18 (20+ recommended) |
| All | npm / pnpm (npm recommended) |
| Master | Bundled SQLite (`better-sqlite3` is an optional dep; npm auto-installs it) |
| Executor | The CLI tool you want to use, globally executable (`claude`, `codex`, `gemini`, etc.) |
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

Open `http://localhost:28800/dashboard` in your browser. The first startup prints a randomly generated dashboard admin password in the logs (log path: `~/.rotom/logs/master.log`). Local connections use loopback trust — **no mesh_token needed**. The executor's scanClis auto-registers one agent each for local claude / codex / hermes / pi.

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

## Option B: Source install (for development / contributions)

For developers who need to modify rotom source, run tests, or submit PRs. Regular users should use Option A.

### 1. Clone + build

```bash
git clone <repo> rotom
cd rotom
pnpm install
pnpm build:master            # tsc + copy dashboard static assets
```

Build artifact: `dist/master/server.js`.

### 2. Start

```bash
# Foreground (dev)
pnpm master

# Daemon (background + log)
pnpm master:start

# Status / restart / stop
pnpm master:status
pnpm master:restart
pnpm master:stop
```

Optional env vars:

```bash
MESH_MASTER_PORT=28800           # default 28800
MESH_MASTER_HOST=0.0.0.0         # default 0.0.0.0
MESH_MASTER_DATA=./mesh-data     # SQLite data dir, default mesh-data/ under repo
```

PID file: `~/.openclaw/mesh-master.pid`. Logs are written by the JS logger to `~/.rotom/logs/mesh-master-YYYY-MM-DD.log` (rotated daily).

### 3. First Dashboard login

Open `http://<master-host>:28800/dashboard` in your browser.

First startup prints a randomly generated dashboard username/password in the logs:

```
[INFO] Dashboard credentials initialized:
       username: admin
       password: <random-string>
```

You can change the password later from within the Dashboard.

### 4. Register the first Agent

Dashboard → Agent management → New → fill name, domain, role, skills, confirm and the system returns a `mesh_xxxxxxxx` token. **This token is shown only once — save it immediately.**

Every client component below uses this token.

### 5. Verify Master is up

```bash
curl http://<master-host>:28800/api/agents \
  -H "Authorization: Bearer <some mesh token>"
```

A JSON array in return means OK.

---

## II. Executor service install (turn CLI tools into Agents)

> For global-npm users: **OPC mode auto-spawns the local executor subprocess from master — you don't need to run this section.** Only read this if you're deploying executor cross-machine (local master + remote executor) or want manual control over the executor lifecycle.

Executor is the agent runtime — it starts N workers, each using a CLI backend (`claude` / `codex` / ...) to claim Issues and reply to group @-mentions.

### 1. Register worker agents on the Master Dashboard

Each worker is an independent digital employee. Dashboard → Agent management → New:

- Name (e.g. `Claude·Agent`)
- Agent type (default is fine. `真人` (Human) only marks a real human member — won't be auto-dispatched)
- Get the token

You can register multiple workers at once (one executor process runs many workers).

### 2. Write the config file `~/.rotom/executor.config.json`

> Path is fixed at `~/.rotom/executor.config.json`. The executor and rotom CLI share this file — the CLI auto-discovers all workers declared in it; no `rotom config add-executor` needed.

```json
{
  "master": "ws://192.168.1.10:28800",
  "workers": [
    {
      "name": "Claude·Agent",
      "token": "mesh_xxxxxxxx",
      "cliTool": "claude",
      "workingDir": "/Users/me/work/projectA",
      "maxConcurrent": 2,
      "profile": {
        "position": "Frontend Engineer",
        "bio": "Owns frontend architecture"
      }
    },
    {
      "name": "Codex·Agent",
      "token": "mesh_yyyyyyyy",
      "cliTool": "codex",
      "workingDir": "/Users/me/work/projectA"
    }
  ]
}
```

Field notes:
- `cliTool`: `claude` / `codex` / `hermes` / any implementation registered under `src/executor/executors/`; auto-detected when omitted
- `workingDir`: **required**, locally-readable base dir. The agent's actual spawn cwd is derived as `<workingDir>/<groupId>` (groupId from the WS message; mkdir -p on first dispatch). The agent only has **read** access in the derived dir (Read / Grep / Glob / read-only Bash) — no Write / Edit. **For cross-machine deployments, each executor configures its own machine's base path; no shared FS needed** — groupId is a logical label, each machine's `<base>/<groupId>` is physically isolated. The master's `working_dir` from WS is ignored by the executor. On startup, the base path is checked for existence / readability; missing or invalid → fail-fast. Recommended base: `~/.rotom/artifacts`.
- `workingDirMap`: optional per-group override, format `{ "group-xxx": "/local/abs/path" }`. When matched, skips derivation and uses the path directly — useful when one executor serves multiple projects.
- `maxConcurrent`: max concurrent tasks for this worker, default 2
- `profile`: optional; if `category: "真人"` is set, this worker won't participate in Issue claiming (only marks a real human member)

Simplified form (single worker):

```json
{
  "master": "ws://...",
  "name": "Claude·Agent",
  "token": "mesh_xxx",
  "cliTool": "claude"
}
```

### 3. Start

```bash
# Direct run (foreground)
pnpm executor                                           # reads default ~/.rotom/executor.config.json
node --import tsx src/executor/index.ts --config /path/to/conf.json

# Daemon: wrap with pm2 / systemd / launchd
pm2 start "pnpm executor" --name mesh-executor
```

### 4. Verify

The startup log should show `Connected to master` and `Authenticated` for every worker. The Dashboard shows the corresponding agent as online.

Send a `[ISSUE] test task\n details` in a group — the executor should claim and ack; or @ this worker in a group to see it reply.

---

## III. rotom CLI install (command-line / Claude Code → Mesh)

> For global-npm users: rotom CLI is already on PATH — just `rotom whoami` and skip this section.

For: shell Claude Code users, or anyone wanting to query directory / create issues / send collab messages from the command line.

rotom doesn't introduce a new identity — it must **borrow a registered agent's token** (from the Executor config). One machine can register multiple, switch as needed.

### 1. Install

**Global npm users**: `rotom` is already on PATH; jump to step 2.

**Source dev**:

```bash
# Build once inside the repo
pnpm install
npx tsc                                  # produces dist/cli/rotom.js

# Option A: pnpm link (recommended for dev)
pnpm link --global

# Option B: manual symlink
ln -s "$PWD/bin/rotom" /usr/local/bin/rotom

# Verify
rotom help
```

### 2. Register the agent you want to "play as"

> rotom has no default agent — **errors out if none registered** (prevents using the wrong token on a multi-agent machine).

All `workers[]` declared in `~/.rotom/executor.config.json` are auto-discovered by rotom CLI — just `--as <name>` works. Only when the executor config isn't at the default path do you need to register manually:

```bash
rotom config add-executor Claude·Agent /custom/path/to/executor.config.json

# Set default agent (optional — otherwise always pass --as)
rotom config use Claude·Agent
rotom config show
```

On register, rotom immediately reads the config to verify token / master resolvability; parse errors fail fast.

### 3. Switch identity

```bash
rotom --as Codex·Agent directory             # single-call switch
ROTOM_AGENT=Claude·Agent rotom group list    # via env
```

Priority: `ROTOM_AGENT` > `--as` > `~/.rotom/config.json` `defaultAgent`.

### 4. Verify

```bash
rotom whoami
# {"local":{"name":"Claude·Agent","kind":"executor",...},"remote":{"kind":"agent","name":"Claude·Agent",...}}

rotom directory --pretty
rotom group list --pretty
```

### 5. Common commands

```bash
rotom directory --online --pretty
rotom group history <groupId> --limit 30 --pretty
rotom group send <groupId> <target> "@target hi"
rotom issue list <groupId> --type task
rotom issue create <groupId> --title T --description D --priority high
```

Full list: `rotom help`.

---

## End-to-end smoke test

After all three pieces are installed:

```bash
# 1. Master health
curl -fs http://<master>:28800/api/agents -H "Authorization: Bearer <token>" | head -c 200

# 2. Agent online (after Executor starts)
rotom directory --online --pretty

# 3. Create group / invite (via Dashboard or API)

# 4. rotom sends a group message; agent responds
rotom group send <gid> Claude·Agent "@Claude·Agent hi"
# wait a few seconds
rotom group history <gid> --limit 5 --pretty
```

---

## Upgrade flow

| Install method | Upgrade command |
|----------------|-----------------|
| **Global npm** (recommended) | `npm update -g @konglx/rotom` (master/executor/rotom all upgrade together) |
| Source | `git pull && pnpm install && pnpm build:master && mesh-master restart` |

Per-component upgrades (source mode):

| Component | Method |
|-----------|--------|
| Master | `git pull && pnpm install && pnpm build:master && pnpm master:restart` |
| Executor | `git pull && pnpm install && pnpm build`, then restart executor |
| rotom | `git pull && npx tsc` (the `bin/rotom` shim prefers `dist/`, falls back to `src/` via tsx) |

---

## Common issues

### Master startup port occupied

```bash
pnpm master:status
pnpm master:stop          # kill old instance
pnpm master:start
```

If the PID file is stale: delete `~/.openclaw/mesh-master.pid` and retry.

### Executor starts but doesn't claim

- Are there open task issues in the group? (Check Dashboard)
- Is the group message in `[ISSUE] title\n detail` format? (Or created via `rotom issue create`)
- Does the executor log show `Claim response: 200`?
- The worker's `category` must NOT be `真人` (human agents don't claim)

### rotom reports `no agent selected`

```bash
rotom config show              # see if any agents exist
rotom config add-executor ...  # register
rotom config use <name>        # set default
```

### rotom returns 404 on `/whoami` etc.

Master is on an older version (`/whoami`, `/cli/groups/:id/send` are newer endpoints). Run `pnpm build:master && pnpm master:restart`.

---

## File manifest

| Path | Description |
|------|-------------|
| `bin/mesh-master.sh` | Master start/stop script |
| `bin/rotom` | rotom CLI launcher |
| `dist/master/server.js` | Master build artifact |
| `dist/cli/rotom.js` | rotom build artifact |
| `~/.rotom/executor.config.json` | Executor config (shared by executor process and rotom CLI) |
