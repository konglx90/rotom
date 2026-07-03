/**
 * rotom note — note list/show/create/update/delete.
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagStr,
  requireFlag,
} from "./common.js";
import { route, usage, unknownSubcommand } from "./routes.js";

export async function cmdNote(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (sub === "list") {
    const groupId = rest[1]; if (!groupId) usage("note list", "<groupId>");
    const data = await api(agent, "GET", route("/groups/:groupId/notes", groupId));
    printTable(
      data.map((n: any) => ({
        id: n.id,
        title: (n.title || "").slice(0, 60),
        created_by: n.created_by,
        updated_at: n.updated_at,
      })),
      ["id", "title", "created_by", "updated_at"],
    );
    return;
  }
  if (sub === "show") {
    const id = rest[1]; if (!id) usage("note show", "<noteId>");
    const data = await api(agent, "GET", route("/notes/:id", id));
    printJson(data);
    return;
  }
  if (sub === "create") {
    const groupId = rest[1]; if (!groupId) usage("note create", "<groupId> --title T [--description D]");
    const title = requireFlag(flags, "title");
    const description = flagStr(flags, "description") || "";
    const data = await api(agent, "POST", route("/groups/:groupId/notes", groupId), {
      title, description, createdBy: agent.name,
    });
    printJson(data);
    return;
  }
  if (sub === "update") {
    const id = rest[1]; if (!id) usage("note update", "<noteId> [--title T] [--description D]");
    const title = flagStr(flags, "title");
    const description = flagStr(flags, "description");
    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (Object.keys(body).length === 0) {
      fail("no fields to update — pass at least one of --title, --description");
    }
    const data = await api(agent, "PUT", route("/notes/:id", id), body);
    printJson(data);
    return;
  }
  if (sub === "delete") {
    const id = rest[1]; if (!id) usage("note delete", "<noteId>");
    const data = await api(agent, "DELETE", route("/notes/:id", id));
    printJson(data);
    return;
  }
  unknownSubcommand("note", sub);
}
