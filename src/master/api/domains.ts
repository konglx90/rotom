import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import type { MeshDb } from "../db.js";

export function registerDomainRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
  apiRouter.get("/domains", (_req, res) => {
    const domains = db.listDomains();
    const enriched = domains.map(d => ({
      ...d,
      agentCount: db.countAgentsByDomain(d.name),
    }));
    res.json(enriched);
  });

  apiRouter.post("/domains", (req, res) => {
    const { name, description } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const trimmed = name.trim();
    const existing = db.getDomainByName(trimmed);
    if (existing) {
      res.status(409).json({ error: `Domain "${trimmed}" already exists` });
      return;
    }
    const id = randomUUID();
    db.insertDomain(id, trimmed, description);
    res.status(201).json({ id, name: trimmed, description: description || null });
  });

  apiRouter.put("/domains/:id", (req, res) => {
    const domain = db.getDomainById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    const { name, description } = req.body;
    if (name !== undefined && name !== domain.name) {
      const dup = db.getDomainByName(name);
      if (dup) {
        res.status(409).json({ error: `Domain "${name}" already exists` });
        return;
      }
      db.renameDomainInAgents(domain.name, name);
    }
    db.updateDomain(domain.id, { name, description });
    res.json({ ok: true });
  });

  apiRouter.delete("/domains/:id", (req, res) => {
    const domain = db.getDomainById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    const count = db.countAgentsByDomain(domain.name);
    if (count > 0) {
      res.status(400).json({ error: `域「${domain.name}」仍有 ${count} 个员工，请先移走。` });
      return;
    }
    const ruleCount = db.countCrossDomainRulesByDomain(domain.name);
    if (ruleCount > 0) {
      res.status(400).json({ error: `域「${domain.name}」仍有 ${ruleCount} 条跨域规则，请先删除。` });
      return;
    }
    db.deleteDomain(domain.id);
    res.json({ ok: true });
  });
}
