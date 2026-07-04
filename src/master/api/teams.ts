/**
 * Federation / Team REST API。
 *
 * Phase 2 MVP 只做 GET(读):
 *   GET /api/identity                  → 本机 master_node 信息(含 teamName)
 *   GET /api/teams                     → 已加入的团队列表(本机视角)
 *   GET /api/teams/:id/members         → 团队内 agent_visibility 联合视图
 *   GET /api/teams/:id/peers           → 团队内 peer master 列表
 *
 * Runtime join/leave(POST)留给 Phase 3 —— 那需要把 fedClient/fedPublisher
 * 从 server.ts main 的局部变量提取成模块级单例,以便 API 层访问。
 * Phase 2 用户通过 ~/.rotom/team.json + 重启 master 切换 federation 状态。
 *
 * 历史命名:Phase 2 叫 department,migration 058 改名 team。API 路径同步改。
 */

import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import { getFederationManager } from "../federation/manager.js";

export function registerTeamRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  // 本机 master 身份
  apiRouter.get("/identity", (_req, res) => {
    const node = db.getMasterNode();
    if (!node) {
      res.status(500).json({ error: "master_node not initialized (OPC bootstrap failed?)" });
      return;
    }
    res.json({
      id: node.id,
      hostname: node.hostname,
      role: node.role,
      displayName: node.display_name,
      teamName: node.team_name ?? node.hostname,
      endpoint: node.endpoint,
      federationEnabled: node.federation_enabled !== 0,
    });
  });

  // 已加入的团队列表
  apiRouter.get("/teams", (_req, res) => {
    const teams = db.listTeams();
    res.json(teams.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      myRole: t.my_role,
      coordEndpoints: t.coord_endpoints.split(",").filter(Boolean),
      joinedAt: t.joined_at,
    })));
  });

  // 团队内可见 agent 列表(包括本机发布出去的 + 其他 member 缓存的)
  apiRouter.get("/teams/:id/members", (req, res) => {
    const teamId = req.params.id;
    const team = db.getTeam(teamId);
    if (!team) {
      res.status(404).json({ error: `Team "${teamId}" not found` });
      return;
    }
    const visible = db.listVisibleAgents(teamId);
    res.json(visible.map((v) => ({
      masterId: v.master_id,
      hostname: v.hostname,
      name: v.agent_name,
      displayName: v.display_name,
      isHuman: v.is_human !== 0,
      online: v.online !== 0,
      lastHeartbeat: v.last_heartbeat,
      // 给 UI 用的复合显示键
      ref: `${v.agent_name}@${v.hostname}`,
    })));
  });

  // 团队内的 peer master 列表(协调侧权威,member 侧缓存)
  apiRouter.get("/teams/:id/peers", (req, res) => {
    const teamId = req.params.id;
    const team = db.getTeam(teamId);
    if (!team) {
      res.status(404).json({ error: `Team "${teamId}" not found` });
      return;
    }
    const peers = db.listPeers(teamId);
    res.json(peers.map((p) => ({
      masterId: p.master_id,
      hostname: p.hostname,
      endpoint: p.endpoint,
      role: p.role,
      lastSeenAt: p.last_seen_at,
    })));
  });

  // ─── Runtime join / leave(无需重启 master)──────────────────────────────

  // POST /api/teams/join  body: { coordEndpoint: "ws://host:port", teamName?: "..." }
  // 本机从 standalone 切到 member,连协调 master,加入大团队。
  apiRouter.post("/teams/join", async (req, res) => {
    const { coordEndpoint, teamName } = req.body || {};
    if (!coordEndpoint || typeof coordEndpoint !== "string") {
      res.status(400).json({ error: "coordEndpoint is required (e.g. ws://192.168.1.5:28800)" });
      return;
    }
    const mgr = getFederationManager();
    if (!mgr) {
      res.status(500).json({ error: "FederationManager not initialized" });
      return;
    }
    try {
      const result = await mgr.joinTeam({ coordEndpoint, teamName });
      res.json({ ok: true, teamId: result.teamId, teamName: result.teamName });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/teams/leave  本机离开大团队,切回 standalone
  apiRouter.post("/teams/leave", (_req, res) => {
    const mgr = getFederationManager();
    if (!mgr) {
      res.status(500).json({ error: "FederationManager not initialized" });
      return;
    }
    try {
      mgr.leaveTeam();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
}
