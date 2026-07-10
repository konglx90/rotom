---
title: Federation · OPC default + Team Federation
description: OPC default form + Federation overlay — coordinator / member / standalone roles, star topology, runtime join/leave
---

# Federation · OPC default + Team Federation

Rotom's deployment has two layers: **OPC** (default, every machine self-governs) and **Federation** (optional overlay, multiple machines federate into a team). Both layers share the same master binary; you switch between three roles via `ROTOM_MASTER_ROLE`. Data formats and protocols are identical.

> Companion site: the Federation section on <https://code.alipay.com/cattery/rotom>.

---

## 1. Three Master roles

| Role | Env var | Description | When to use |
|------|---------|-------------|-------------|
| `standalone` | (default) | Single-machine OPC, no coordinator, fully local | Personal digital employees / single-machine dev |
| `coordination` | `ROTOM_MASTER_ROLE=coordination` | Accepts member connections, relays cross-machine messages | Team hub — needs a stable address |
| `member` | `ROTOM_MASTER_ROLE=member` | Connects to coordinator outbound, local data preserved, cross-machine visibility published | Team member machines, mobile-friendly |

Resolution logic: `src/master/federation/identity.ts:143`. Phase 1 enables standalone behavior only; Phase 2 lands coordination/member.

---

## 2. OPC mode (default, every machine)

### 2.1 One-command startup

```bash
# Recommended: rotom CLI (v2.20+)
rotom run opc

# Equivalent
pnpm start
# = bin/rotom-up.sh start
# = mesh-master start --daemon
```

### 2.2 The 4 things master does automatically

1. Generate `masterId` (8-char base36, persisted at `~/.rotom/master.json`)
2. Create a default agent (using `os.userInfo().username`) and a default group "Local"
3. Spawn the local executor subprocess (`src/master/opc-bootstrap.ts:ensureLocalExecutor`)
4. Executor scanClis scans local claude/codex/hermes/pi and registers one agent each

### 2.3 Key constraints

- **Local connections use loopback trust, no mesh_token** — agents auto-register on first contact
- **Hostname validation** — rejects IP literals (mobile IPs are unstable); see `src/master/federation/identity.ts`
- **Persistent masterId** — survives network/IP changes
- `ROTOM_FEDERATION_DISABLED=1` forces pure standalone

---

## 3. Federation mode (optional overlay)

### 3.1 Star topology

```
              ┌────────────────────────┐
              │  Coordination Master    │
              │  (ROTOM_MASTER_ROLE=   │
              │   coordination)         │
              │  :28800                 │
              │  Holds routing metadata │
              └──────────┬─────────────┘
                         │  /federation WS
          ┌──────────────┼──────────────┐
          │              │              │
   ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
   │  Member 1  │  │  Member 2  │  │  Member 3  │
   │ (outbound) │  │ (outbound) │  │ (outbound) │
   │ Data local │  │ Data local │  │ Data local │
   └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
          │              │              │
       agents         agents          agents
```

- **Data stays local** — agent / memory / issue always on the local master
- **Coordinator only holds routing metadata** — team_peers / agent_visibility
- **Members connect outbound** — auto-reconnect on network change (see `src/master/federation/client.ts`)
- **Coordinator needs a stable address** — mobile machines shouldn't be coordinators

### 3.2 Start the coordinator master

```bash
# Recommended: rotom CLI (v2.20+)
rotom run federation
# equivalent: ROTOM_MASTER_ROLE=coordination bin/rotom-up.sh start

# Manual
ROTOM_MASTER_ROLE=coordination ROTOM_TEAM_NAME="A-Team" pnpm start
```

After startup:
- Master listens on `/federation` WebSocket (distinct from the agent `/ws`; see `src/master/federation/server.ts`)
- Waits for member connections
- Dashboard → Team page shows join requests and member list

### 3.3 Start a member master

**Option A: Dashboard runtime join (recommended, no restart)**

1. On the member machine, start normally with `rotom run opc`
2. Open `http://localhost:28800/dashboard` → Team page
3. Enter coordinator address (`ws://coord-host:28800`) + team name → Join
4. Master calls `POST /api/teams/join` at runtime to switch to member role

**Option B: Pre-write team.json + env var**

```bash
# Write ~/.rotom/team.json
cat > ~/.rotom/team.json <<'EOF'
{
  "id": "<coordinator's masterId, 8-char base36>",
  "name": "A-Team",
  "coord_endpoints": ["ws://coord-host:28800"]
}
EOF

# Start
ROTOM_MASTER_ROLE=member ROTOM_TEAM_NAME="A-Team" pnpm start
```

### 3.4 Behavior after joining

- **Agents auto-publish** — local agents are pushed to the coordinator, visible to other members (see `FedAgentPublish` protocol)
- **Cross-machine messages relay through coordinator** — `src/master/router.ts` falls back to federationClient.route when no local agent matches
- **Data stays local** — agent / memory / issue always on local master; coordinator only holds routing metadata
- **Offline queue** — 100 messages / 24h TTL; auto-delivered on reconnect

### 3.5 Leaving a team

```bash
# Dashboard → Team page → Leave
# Or via API
curl -X POST http://127.0.0.1:28800/api/teams/leave

# Or restart without team.json — falls back to standalone
```

---

## 4. Config reference

### 4.1 Master startup params / env vars

| Var | Default | Description |
|-----|---------|-------------|
| `MESH_MASTER_PORT` | `28800` | Master listen port |
| `MESH_MASTER_HOST` | `0.0.0.0` | Master listen address |
| `ROTOM_HOME` | `~/.rotom` | Data dir (SQLite + logs + PID) |
| `ROTOM_HOSTNAME` | `os.hostname()` | Local hostname (for federation; **never use IP**) |
| `ROTOM_MASTER_ROLE` | `standalone` | `standalone` / `coordination` / `member` |
| `ROTOM_TEAM_NAME` | Derived from the human agent | Team display name (e.g. "A-Team") |
| `ROTOM_COORD_ENDPOINTS` | — | Member mode: comma-separated coordinator ws URLs |
| `ROTOM_FEDERATION_DISABLED` | — | `=1` forces federation off (pure standalone) |

### 4.2 team.json (`~/.rotom/team.json`, member mode)

```json
{
  "id": "<coordinator's masterId, 8-char base36>",
  "name": "A-Team",
  "coord_endpoints": ["ws://coord-host:28800"]
}
```

Can also be generated at runtime from Dashboard → Team page (no restart needed).

### 4.3 executor.config.json (`~/.rotom/executor.config.json`)

In OPC mode, master auto-generates `.auto-executor.json` (scanClis mode); manual writing is unnecessary. To give agents Chinese names or specify workingDir, write `executor.config.json` (priority over auto):

```json
{
  "master": "ws://localhost:28800",
  "workers": [
    {
      "name": "John Doe",
      "cliTool": "claude",
      "workingDir": "/Users/me/work/projectA",
      "maxConcurrent": 2,
      "profile": { "position": "Full-stack Engineer", "bio": "Main contributor" }
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `master` | `string` | Master WebSocket URL |
| `workers[]` | `array` | Worker list (single-worker simplified form also supported) |
| `workers[].name` | `string` | Agent name (OPC mode trusts local, no DB pre-registration needed) |
| `workers[].token` | `string?` | **Optional in OPC mode** (local trust); required for cross-machine remote master |
| `workers[].cliTool` | `string?` | `claude` / `codex` / `hermes` / `pi`; auto-detected when omitted |
| `workers[].workingDir` | `string?` | Task execution dir, default `~/.rotom/workspace` |
| `workers[].maxConcurrent` | `number?` | Concurrency cap, default 2 |
| `workers[].profile` | `object?` | Agent profile; `category: "真人"` excludes from claiming |

---

## 5. Federation REST API

All endpoints under `/api`. Local calls use loopback trust (no token); remote calls use `Authorization: Bearer <mesh_token>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/identity` | Local master identity (masterId / hostname / role / teamName) |
| GET | `/api/teams` | Joined team list |
| GET | `/api/teams/:id/members` | Visible agents in the team (agent_visibility) |
| GET | `/api/teams/:id/peers` | Peer master list in the team |
| POST | `/api/teams/join` | Runtime join a parent team (body: `{ coordEndpoint, teamName? }`) |
| POST | `/api/teams/leave` | Runtime leave the team, switch back to standalone |
| POST | `/api/agents/:id/refresh-token` | Refresh token |

---

## 6. Federation protocol (master ↔ master)

A v1 protocol separate from the agent protocol (v2), mounted at `/federation`.

- **FedAgentPublish** — member pushes local agents to coordinator; coordinator broadcasts `FedDirectorySync`
- **FedRouteMessage** — member routes to coordinator when no local agent matches
- **FedDeliver** — coordinator delivers to the target member
- **FedReply** — reply returns to the originating member, resolves pendingRequest

Implementation entry points:
- `src/master/federation/server.ts` — coordinator side, accepts member connections
- `src/master/federation/client.ts` — member side, connects outbound
- `src/master/federation/manager.ts` — FederationManager, encapsulates join/leave lifecycle
- `src/master/federation/publisher.ts` — agent publish & visibility sync
- `src/master/router.ts:setFederation()` — injects into the main router

---

## 7. FAQ

**Q: Does the coordinator need a public IP?**
A: No public IP needed, but a stable address reachable by members. LAN IP / internal DNS / public IP all work — as long as members can connect outbound. **Don't use `127.0.0.1` or `localhost`** (members on another machine can't reach it).

**Q: What if a member's network changes?**
A: Members connect outbound; the client has exponential backoff reconnect (see `src/master/federation/client.ts`). Auto-reconnects after network recovery; offline messages go through the coordinator's offline queue (100 msgs / 24h TTL).

**Q: What if the coordinator goes down?**
A: Each member is still a standalone OPC — local agent / memory / issue all keep working; only cross-machine routing is temporarily unavailable. Members auto-reconnect when the coordinator returns.

**Q: Can I join multiple teams at once?**
A: No. A master can belong to only one team at a time (must leave before joining another). `FederationManager.joinTeam` throws "Already a member of a team — leave first".

**Q: Can the coordinator see cross-machine message content?**
A: The coordinator forwards FedRouteMessage / FedDeliver; message bodies are opaque to it (protocol layer doesn't parse business payload). Coordinator only holds routing metadata (team_peers / agent_visibility), not agent / memory / issue data.

**Q: Does the coordinator know an agent's mesh_token?**
A: No. Tokens are only for agent ↔ local-master auth; members talk to coordinators via federation protocol, no agent token is transmitted.
