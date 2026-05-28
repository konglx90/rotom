# OpenClaw A2A Gateway

Digital Employee Mesh — a hub-and-spoke network that connects OpenClaw agents via a central Master relay.

## Architecture

```
                      ┌──────────────────────────────┐
                      │       Master (:18800)         │
                      │                               │
                      │  HTTP  /api/*    REST CRUD    │
                      │  WS    /ws       Hub relay    │
                      │  Web   /dashboard SPA         │
                      │  DB    SQLite WAL             │
                      └──┬──────────┬──────────┬──────┘
                   ws:// │          │          │ ws://
                         ▼          ▼          ▼
                  ┌──────────┐ ┌──────────┐ ┌──────────┐
                  │ Agent A  │ │ Agent B  │ │ Agent C  │
                  │ (plugin) │ │ (plugin) │ │ (plugin) │
                  └──────────┘ └──────────┘ └──────────┘

  All agent-to-agent messages are relayed through the Master.
  No peer-to-peer connections.
```

## Features

### Master

- WebSocket hub with token (sha256) + JWT authentication
- Agent registry with domain isolation and cross-domain rules
- Message routing (exact name match) with offline queue (100 msgs, 24h TTL)
- REST API for agent/domain/rule CRUD and audit logs
- Built-in dashboard (single-page app)
- Rate limiting (60 msg/min per agent), message deduplication

### Agent (OpenClaw Plugin)

- Auto-connect with multi-URL failover and exponential backoff reconnect
- Local directory cache (full sync on connect, incremental updates)
- Inbound dispatch: relay messages to local LLM via SSE `/v1/chat/completions`
- Message filtering (allowFrom / blockFrom)
- LLM tools: `mesh_directory`, `mesh_group_send`, and more

### Protocol

- WebSocket binary/text frames, JSON messages, protocol version 2
- Heartbeat (10s interval / 90s timeout)
- Offline message delivery on reconnect
- Reply correlation via `requestId`

## Quick Start

### 1. Start the Master

```bash
cd openclaw-a2a-gateway
pnpm install
pnpm build
node dist/src/master/server.js --port 18800 --data ./mesh-data
```

Open `http://localhost:18800/dashboard` to access the management panel.

### 2. Register an Agent

Use the dashboard or the REST API:

```bash
curl -X POST http://localhost:18800/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "my-agent", "description": "My first digital employee"}'
```

The response includes a `token` (prefixed `mesh_`) and a `configTemplate` you can paste into `openclaw.json`.

### 3. Configure the OpenClaw Plugin

Add to your `openclaw.json`:

```json
{
  "channels": {
    "a2a-gateway": {
      "master": "ws://MASTER_IP:18800",
      "name": "my-agent",
      "token": "mesh_xxxx",
      "description": "My first digital employee",
      "enabled": true
    }
  }
}
```

Restart OpenClaw. The agent will connect to the Master automatically.

## Configuration

### Agent-side (`openclaw.json` → `channels.a2a-gateway`)

| Field | Type | Description |
|-------|------|-------------|
| `master` | `string \| string[]` | Master WebSocket URL(s). Array enables failover. |
| `name` | `string` | Unique agent name |
| `token` | `string` | Registration token (`mesh_` prefix) |
| `description` | `string` | Agent description (updatable at runtime) |
| `filter.allowFrom` | `string[]` | Whitelist — only accept messages from these agents |
| `filter.blockFrom` | `string[]` | Blacklist — reject messages from these agents |
| `enabled` | `boolean` | Enable/disable the plugin |

### Master-side (CLI)

```
mesh-master [options]
  --port <number>    HTTP/WS port (default: 18800)
  --host <string>    Bind address (default: 0.0.0.0)
  --data <path>      Data directory for SQLite (default: ./mesh-data)
```

## REST API

All endpoints are under `/api`.

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/online` | List online agents (compact) |
| POST | `/api/agents` | Register agent → returns token + configTemplate |
| GET | `/api/agents/:id` | Agent detail |
| PUT | `/api/agents/:id` | Update agent (description / domain / enabled) |
| DELETE | `/api/agents/:name` | Delete agent (must be offline) |
| GET | `/api/agents/:id/token` | View token (masked) |
| POST | `/api/agents/:id/refresh-token` | Refresh token |

### Domains

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/domains` | List domains (with agent count) |
| POST | `/api/domains` | Create domain |
| PUT | `/api/domains/:id` | Update domain (cascade rename) |
| DELETE | `/api/domains/:id` | Delete domain (must have no agents) |

### Cross-Domain Rules

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cross-domain` | List rules |
| POST | `/api/cross-domain` | Add rule (supports bidirectional) |
| DELETE | `/api/cross-domain` | Delete rule |

### Observability

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/audit` | Audit log (limit, max 500) |
| GET | `/api/stats` | Stats + per-agent message metrics |
| GET | `/api/messages` | Message log (agent / limit / before) |
| GET | `/api/conversations` | Conversations grouped by peer |

## LLM Tools

The plugin registers two tools that the LLM can call:

### `mesh_directory`

Query the local agent directory cache.

| Parameter | Type | Description |
|-----------|------|-------------|
| `domain` | `string?` | Filter by domain |
| `onlineOnly` | `boolean?` | Only show online agents |

### `mesh_group_send`

Send a message in a group. All members see the reply.

## Protocol

WebSocket endpoint: `ws://master:18800/ws`

### Client → Master

| Type | Key Fields | Description |
|------|-----------|-------------|
| `auth` | `token`, `name`, `jwt?` | Authenticate (required within 10s) |
| `heartbeat` | `activeDispatches?` | Keep-alive (every 10s) |
| `a2a_send` | `requestId`, `target`, `payload` | Send message to target agent |
| `a2a_reply` | `requestId`, `payload` | Reply to a received message |
| `update_info` | `description?` | Update own metadata |
| `disconnect` | — | Graceful disconnect |

### Master → Client

| Type | Key Fields | Description |
|------|-----------|-------------|
| `auth_ok` | `jwt`, `directory[]`, `config?` | Auth success + full directory |
| `auth_fail` | `reason` | Auth failed |
| `heartbeat_ack` | — | Heartbeat response |
| `a2a_message` | `requestId`, `from`, `payload` | Incoming message |
| `route_result` | `requestId`, `delivered`, `queued` | Routing feedback |
| `directory_update` | `event`, `agent` | Directory change (join/leave/update) |
| `offline_messages` | `messages[]` | Queued messages on reconnect |
| `config_update` | `domain?`, `enabled?` | Master-pushed config change |

### Payload Structure

```typescript
interface MessagePayload {
  message: string
  files?: Array<{ name: string; uri: string; mimeType?: string }>
}
```

### WS Close Codes

| Code | Meaning |
|------|---------|
| 4001 | Auth timeout |
| 4002 | Auth failed |
| 4400 | Invalid JSON |
| 4401 | Not authenticated |
| 4429 | Rate limited |

## Development

### Build

```bash
pnpm install
pnpm build        # tsc + copy dashboard assets
```

### Test

```bash
pnpm test                                      # all tests
npx tsx --test tests/master-agent.test.ts       # integration test
```

### Project Structure

```
src/
├── index.ts                    # Agent-side entry (OpenClaw plugin)
├── master/
│   ├── server.ts               # Master standalone entry (CLI)
│   ├── embedded.ts             # Embeddable master (same-process)
│   ├── api.ts                  # REST API routes
│   ├── ws-hub.ts               # WebSocket hub (connections + relay)
│   ├── router.ts               # Routing decisions
│   ├── db.ts                   # SQLite data layer (WAL mode)
│   ├── auth.ts                 # Token verification + JWT
│   ├── offline-queue.ts        # Offline message queue
│   └── dashboard/index.html    # Management dashboard (SPA)
├── agent/
│   ├── agent-mode.ts           # Agent main entry
│   ├── socket-manager.ts       # WS lifecycle (auth + heartbeat + reconnect)
│   ├── ws-client.ts            # Low-level WebSocket client
│   ├── directory.ts            # Local agent directory cache
│   ├── inbound-dispatcher.ts   # Inbound → local LLM (SSE)
│   ├── outbound-handler.ts     # Outbound → Master
│   ├── message-filter.ts       # Allow/block list
│   └── tools.ts                # mesh_directory + mesh_group_send
└── shared/
    ├── protocol.ts             # Message type definitions
    ├── constants.ts            # Global constants
    └── dedup.ts                # Message deduplication
```

## License

MIT
