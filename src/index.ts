/**
 * Digital Employee Mesh — OpenClaw Plugin Entry Point
 *
 * Pure agent plugin — connects to an external Master via WebSocket.
 * Master runs as a separate process (node dist/master/server.js).
 */

import { AgentMode, type MeshAgentConfig } from "./agent/agent-mode.js";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Plugin config shape (from channels.a2a-gateway in openclaw.json)
// ---------------------------------------------------------------------------

interface MeshPluginConfig {
  /** Master URL(s) — e.g. "ws://10.0.0.1:19800" */
  master: string | string[];

  /** Agent name in the mesh */
  name: string;

  /** Registration token */
  token: string;

  /** Agent description */
  description?: string;

  /** Agent structured profile */
  profile?: {
    position?: string;
    responsibilities?: string;
    tech_stack?: string;
  };

  /** Message filter rules */
  filter?: { allowFrom?: string[]; blockFrom?: string[] };

  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let agentMode: AgentMode | null = null;
/** OpenClaw PluginRuntime — provides channel.routing, channel.reply, system APIs */
let meshRuntime: any = null;
const DEFAULT_ACCOUNT_ID = "__default__";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenClaw home directory from env vars.
 * OPENCLAW_CONFIG_PATH=~/.openclaw-xiaoshan/openclaw.json → ~/.openclaw-xiaoshan
 * OPENCLAW_HOME=~/.openclaw → ~/.openclaw
 * fallback: undefined (let downstream resolve)
 */
function resolveOpenClawHome(): string | undefined {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (configPath) {
    const resolved = configPath.startsWith("~")
      ? configPath.replace("~", process.env.HOME || "")
      : configPath;
    return path.dirname(resolved);
  }
  const home = process.env.OPENCLAW_HOME;
  if (home) {
    return home.startsWith("~") ? home.replace("~", process.env.HOME || "") : home;
  }
  return undefined;
}

/** Return the first non-loopback IPv4 address, or "127.0.0.1" as fallback. */
function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function getChannelConfig(cfg: any): MeshPluginConfig | null {
  const raw = cfg?.channels?.["a2a-gateway"];
  if (!raw || !raw.name || !raw.token || !raw.master) return null;
  return raw as MeshPluginConfig;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default function register(api: any): void {
  const logger = api.logger ?? console;

  // Save PluginRuntime for SDK access (channel.routing, channel.reply, system)
  meshRuntime = api.runtime;

  // ── ChannelPlugin object (follows OpenClaw ChannelPlugin type) ──────────
  const meshPlugin = {
    id: "a2a-gateway",
    meta: {
      name: "Digital Employee Mesh",
      description: "Enterprise agent collaboration network",
    },
    capabilities: {},
    reload: { configPrefixes: ["channels.a2a-gateway"] },
    configSchema: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "调度中心分配的唯一标识" },
          token: { type: "string", description: "调度中心分配的认证凭证" },
          master: { type: "string", description: "调度中心 WebSocket 地址" },
          description: { type: "string", default: "", description: "自我介绍（其他节点可见）" },
          enabled: { type: "boolean", default: true, description: "启用 Mesh 网络" },
          profile: {
            type: "object",
            description: "员工结构化介绍（岗位、负责、技术栈）",
            properties: {
              position: { type: "string", description: "岗位，如：前端开发工程师" },
              responsibilities: { type: "string", description: "负责内容，如：负责保险业务前端架构" },
              tech_stack: { type: "string", description: "技术栈，如：React, TypeScript, Node.js" },
            },
          },
        },
        required: ["name", "token", "master"],
      },
      uiHints: {
        name: { label: "名称", order: 1 },
        token: { label: "令牌", sensitive: true, order: 2 },
        master: { label: "调度中心地址", order: 3, placeholder: "ws://10.0.0.1:19800" },
        description: { label: "描述", order: 4, placeholder: "例：负责保险业务咨询的数字员工" },
        enabled: { label: "启用", order: 10 },
      },
    },
    config: {
      listAccountIds: (cfg: any): string[] => {
        const config = getChannelConfig(cfg);
        return config ? [DEFAULT_ACCOUNT_ID] : [];
      },
      resolveAccount: (cfg: any, _accountId?: string) => {
        const config = getChannelConfig(cfg);
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          config: config || {},
          enabled: config?.enabled !== false,
        };
      },
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isConfigured: (account: any) => {
        const cfg = account?.config;
        return Boolean(cfg?.name && cfg?.token && cfg?.master);
      },
      describeAccount: (account: any) => ({
        accountId: account?.accountId || DEFAULT_ACCOUNT_ID,
        name: account?.config?.name || "Mesh Agent",
        enabled: account?.enabled !== false,
        configured: Boolean(account?.config?.name),
      }),
    },
    gateway: {
      startAccount: async (ctx: any) => {
        const { account, cfg, abortSignal } = ctx;
        const config = account?.config as MeshPluginConfig;

        if (!config?.name || !config?.token || !config?.master) {
          throw new Error("Mesh: name, token, and master URL are required");
        }

        const gatewayPort = cfg?.gateway?.port ?? parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789");
        const localIp = getLocalIp();
        const endpoint = `ws://${localIp}:${gatewayPort}`;
        const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

        const masterUrls = Array.isArray(config.master) ? config.master : [config.master];

        const agentConfig: MeshAgentConfig = {
          connection: {
            masterUrls,
            name: config.name,
            token: config.token,
            description: config.description,
            profile: config.profile,
            endpoint,
          },
          gatewayUrl,
          gatewayToken: cfg?.gateway?.auth?.token,
          filter: config.filter,
          openclawHome: resolveOpenClawHome(),
          runtime: meshRuntime,
          cfg,
        };

        agentMode = new AgentMode(agentConfig, logger);
        agentMode.start();

        logger.info(`[mesh] Agent "${config.name}" connecting to ${masterUrls[0]}`);

        // Keep alive until abort
        return new Promise<void>((resolve) => {
          if (abortSignal) {
            abortSignal.addEventListener("abort", () => {
              agentMode?.stop();
              agentMode = null;
              resolve();
            }, { once: true });
          }
        });
      },
    },
  };

  // Register as channel plugin
  api.registerChannel({ plugin: meshPlugin });

  // ── Tools ─────────────────────────────────────────────────────────────
  // mesh_* tools are no longer exposed to the LLM. All mesh operations now
  // go through the rotom CLI (Bash), which gives the model one consistent
  // surface and centralises auth / formatting. The MeshToolExecutor instance
  // inside agentMode is still alive — it consumes server messages (route_result,
  // create_issue_response, etc.) and tracks group-reply provenance for the
  // inbound dispatcher; only the LLM-facing registration is removed.

  // ── Gateway Methods ───────────────────────────────────────────────────
  api.registerGatewayMethod("mesh.status", async () => ({
    connected: agentMode?.connected ?? false,
    directory: agentMode?.getDirectory()?.list() ?? [],
  }));

  api.registerGatewayMethod("mesh.directory", async (params: any) => {
    if (!agentMode?.connected) return { error: "Not connected" };
    const dir = agentMode.getDirectory();
    if (params?.domain) return dir.byDomain(params.domain);
    if (params?.onlineOnly) return dir.online();
    return dir.list();
  });

  api.registerGatewayMethod("mesh.group_send", async (params: any) => {
    if (!agentMode?.connected) return { error: "Not connected" };
    if (!params?.target || !params?.message || !params?.groupId) {
      return { error: "target, message and groupId required" };
    }
    return JSON.parse(await agentMode.executeTool("mesh_group_send", params));
  });

  api.registerGatewayMethod("mesh.group_messages", async (params: any) => {
    if (!agentMode?.connected) return { error: "Not connected" };
    if (!params?.groupId) return { error: "groupId required" };
    return JSON.parse(await agentMode.executeTool("mesh_group_messages", params));
  });

  api.registerGatewayMethod("mesh.group_members", async (params: any) => {
    if (!agentMode?.connected) return { error: "Not connected" };
    if (!params?.groupId) return { error: "groupId required" };
    return JSON.parse(await agentMode.executeTool("mesh_group_members", params));
  });

  api.registerGatewayMethod("mesh.create_issue", async (params: any) => {
    if (!agentMode?.connected) return { error: "Not connected" };
    if (!params?.groupId || !params?.title) return { error: "groupId and title required" };
    return JSON.parse(await agentMode.executeTool("mesh_create_issue", params));
  });

  logger.info("[mesh-plugin] Digital Employee Mesh registered");
}
