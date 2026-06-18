import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api");

export function registerNoteRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
  apiRouter.get("/groups/:groupId/notes", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    res.json(db.listNotesByGroup(req.params.groupId));
  });

  apiRouter.post("/groups/:groupId/notes", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) {
      res.status(403).json({ error: "Group is archived, cannot create notes" });
      return;
    }
    const { title, description, createdBy } = req.body;
    if (!title || !createdBy) {
      res.status(400).json({ error: "title and createdBy are required" });
      return;
    }
    const id = randomUUID();
    db.createNote({
      id, groupId: req.params.groupId,
      title: String(title).trim(),
      description: description == null ? "" : String(description),
      createdBy,
    });
    log.info(`Note created: "${title}" (${id}) in group ${req.params.groupId}`);
    res.status(201).json({ id, title });
  });

  apiRouter.get("/notes/:id", (req, res) => {
    const note = db.getNoteById(req.params.id);
    if (!note) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    res.json(note);
  });

  apiRouter.put("/notes/:id", (req, res) => {
    const note = db.getNoteById(req.params.id);
    if (!note) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    const { title, description } = req.body;
    const fields: { title?: string; description?: string } = {};
    if (title !== undefined) {
      const t = String(title).trim();
      if (!t) {
        res.status(400).json({ error: "title cannot be empty" });
        return;
      }
      fields.title = t;
    }
    if (description !== undefined) {
      fields.description = description === null ? "" : String(description);
    }
    db.updateNote(req.params.id, fields);
    res.json({ ok: true });
  });

  apiRouter.delete("/notes/:id", (req, res) => {
    const note = db.getNoteById(req.params.id);
    if (!note) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    db.deleteNote(req.params.id);
    res.json({ ok: true });
  });
}
