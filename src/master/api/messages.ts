import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import type { Router } from "../router.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api");

export function registerMessageRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
  _auth: unknown,
  hub?: WSHub,
  router?: Router,
): void {
  apiRouter.get("/audit", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    res.json(db.listAudit(limit));
  });

  apiRouter.get("/stats", (_req, res) => {
    const basic = db.stats();
    const msgStats = db.agentMessageStats();
    res.json({ ...basic, agents: msgStats });
  });

  apiRouter.get("/messages", (req, res) => {
    const agent = req.query.agent as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const status = req.query.status as string | undefined;
    const keyword = req.query.keyword as string | undefined;
    const groupId = req.query.groupId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const before = req.query.before as string | undefined;
    const messages = db.listMessages({ agent, from, to, status, keyword, groupId, limit, offset, before });
    const total = db.countMessages({ agent, from, to, status, keyword, groupId, before });
    res.json({ messages, total });
  });

  apiRouter.post("/messages/send", (req, res) => {
    const { from, to, message } = req.body;

    if (!from || !to || !message) {
      res.status(400).json({ error: "from, to, and message are required" });
      return;
    }

    const fromAgent = db.getAgentByName(from);
    if (!fromAgent) {
      res.status(404).json({ error: `Sender agent "${from}" not found` });
      return;
    }

    const toAgent = db.getAgentByName(to);
    if (!toAgent) {
      res.status(404).json({ error: `Target agent "${to}" not found` });
      return;
    }

    const requestId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!router) {
      res.status(500).json({ error: "Message router not available" });
      return;
    }

    const routeResult = router.route(fromAgent.id as string, {
      requestId,
      target: to,
      payload: { message }
    });

    if (routeResult.error) {
      res.status(500).json({ error: routeResult.error });
      return;
    }

    let delivered = false;
    let queued = false;

    if (routeResult.targetAgentId && hub) {
      delivered = hub.sendToAgent(routeResult.targetAgentId, {
        type: "a2a_message",
        requestId,
        from: { name: from, domain: fromAgent.domain || undefined, status: "online" },
        payload: { message },
        routeType: "exact",
      });

      if (!delivered) {
        queued = true;
      }
    }

    db.logMessage({
      requestId,
      fromName: from,
      fromDomain: fromAgent.domain || undefined,
      toName: to,
      toDomain: toAgent.domain || undefined,
      routeType: "exact",
      direction: "send",
      payload: JSON.stringify({ message }),
      status: routeResult.error ? "failed" : queued ? "queued" : delivered ? "delivered" : "failed",
      source: "api",
    });

    res.json({
      requestId,
      delivered,
      queued,
      message: "Message sent successfully"
    });
  });

  // Cancel an in-flight streaming chat reply. Body: { requestId, agentName, reason? }.
  // agentName is the responder currently generating (the streaming bubble's `from`),
  // not the original sender — master uses it to route the chat_cancelled WS message
  // to that specific worker. Returns delivered=false when the responder is offline
  // or unknown; the caller can treat that as "stream is already broken" and move on.
  apiRouter.post("/messages/cancel", (req, res) => {
    const { requestId, agentName, reason } = req.body || {};
    if (!requestId || typeof requestId !== "string" ||
        !agentName || typeof agentName !== "string") {
      res.status(400).json({ error: "requestId and agentName are required" });
      return;
    }
    if (!hub) {
      res.status(500).json({ error: "WSHub not available" });
      return;
    }
    const delivered = hub.pushChatCancel(
      agentName,
      requestId,
      typeof reason === "string" && reason ? reason : undefined,
    );
    res.json({ ok: true, delivered });
  });

  apiRouter.get("/whoami", (req, res) => {
    const agentAuth = (req as any).agentAuth as { name: string; id: string } | undefined;
    if (agentAuth) {
      const agent = db.getAgentById(agentAuth.id);
      res.json({ kind: "agent", name: agentAuth.name, id: agentAuth.id, domain: agent?.domain || null });
      return;
    }
    res.json({ kind: "dashboard" });
  });

  apiRouter.post("/cli/groups/:groupId/send", (req, res) => {
    const agentAuth = (req as any).agentAuth as { name: string } | undefined;
    if (!agentAuth) {
      res.status(403).json({ error: "Mesh token required (use a Bearer mesh_xxx token)" });
      return;
    }
    if (!hub) { res.status(500).json({ error: "WSHub not available" }); return; }
    const group = db.getGroupById(req.params.groupId);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot send messages" }); return; }
    const { target, message } = req.body || {};
    if (!target || !message) { res.status(400).json({ error: "target and message are required" }); return; }
    const r = hub.sendAsAgent({
      fromName: agentAuth.name,
      target,
      message,
      groupId: req.params.groupId,
      groupName: group.name,
    });
    if (r.error) { res.status(400).json(r); return; }
    res.json(r);
  });
}
