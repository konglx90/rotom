import { toBeijing } from "../shared/time.js";
/**
 * rotom schedule — schedule list/show/add/update/remove/enable/disable/trigger.
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagStr,
  flagInt,
  requireFlag,
  pretty,
} from "./common.js";
import { route, qs, usage } from "./routes.js";

function parseDuration(input: string): number | null {
  const s = String(input).trim();
  const m = s.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day)?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase();
  switch (unit) {
    case "s": case "sec":       return n;
    case "m": case "min":       return n * 60;
    case "h": case "hr":        return n * 3600;
    case "d": case "day":       return n * 86400;
    default: return null;
  }
}

function formatNextRun(ms: number): string {
  if (!ms) return "-";
  try { return toBeijing(ms); } catch { return String(ms); }
}

export async function cmdSchedule(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];

  if (sub === "list") {
    const gid = flagStr(flags, "group");
    const routePath = `${route("/schedules")}${qs({ group_id: gid })}`;
    const data = await api(agent, "GET", routePath);
    if (pretty) {
      printTable(
        (data as any[]).map((t) => ({
          id: t.id,
          name: t.name,
          group: t.group_id.slice(0, 8),
          mode: t.mode,
          kind: t.schedule_kind,
          every: t.interval_sec ? `${t.interval_sec}s` : "-",
          enabled: t.enabled ? "yes" : "no",
          repeat: t.repeat_times ?? "\u221E",
          ran: t.repeat_count,
          last_status: t.last_status ?? "-",
          next_run_at: formatNextRun(t.next_run_at),
        })),
        ["id", "name", "group", "mode", "kind", "every", "enabled", "repeat", "ran", "last_status", "next_run_at"],
      );
    } else {
      printJson(data);
    }
    return;
  }

  if (sub === "show") {
    const id = rest[1]; if (!id) usage("schedule show", "<id>");
    const data = await api(agent, "GET", route("/schedules/:id", id));
    printJson(data);
    return;
  }

  if (sub === "add") {
    const groupId  = requireFlag(flags, "group");
    const modeRaw  = flagStr(flags, "mode") || "agent";
    if (modeRaw !== "agent" && modeRaw !== "message") {
      fail(`--mode must be "agent" or "message" (got: ${modeRaw})`);
    }
    const mode = modeRaw as "agent" | "message";
    const agentName = flagStr(flags, "agent");
    if (mode === "agent" && !agentName) {
      fail("--agent is required when --mode agent");
    }
    const prompt = requireFlag(flags, "prompt");
    const name = flagStr(flags, "name") || `schedule-${Date.now()}`;
    const repeatRaw = flagStr(flags, "repeat");
    const enabledRaw = flagStr(flags, "enabled");

    const everyRaw = flagStr(flags, "every");
    const inRaw = flagStr(flags, "in");
    const atRaw = flagStr(flags, "at");
    const presentSchedule = [everyRaw, inRaw, atRaw].filter(Boolean).length;
    if (presentSchedule !== 1) {
      fail(
        "exactly one of --every / --in / --at is required\n" +
        "  --every <dur>      e.g. 30s, 5m, 2h, 1d   (interval schedule)\n" +
        "  --in <dur>         e.g. 3m                  (one-shot, relative)\n" +
        "  --at <iso-time>    e.g. 2026-06-22T09:00    (one-shot, absolute)",
      );
    }

    const body: Record<string, unknown> = { name, group_id: groupId, mode, prompt };
    if (mode === "agent" && agentName) body.agent_name = agentName;
    if (enabledRaw !== undefined) body.enabled = enabledRaw !== "false" && enabledRaw !== "0";

    if (everyRaw !== undefined) {
      const sec = parseDuration(everyRaw);
      if (sec === null || sec < 30) fail(`--every must parse to >= 30s (got: ${everyRaw})`);
      body.schedule_kind = "interval";
      body.interval_sec = sec;
    } else if (inRaw !== undefined) {
      const sec = parseDuration(inRaw);
      if (sec === null || sec <= 0) fail(`--in must parse to a positive duration (got: ${inRaw})`);
      body.schedule_kind = "once";
      body.run_at = Date.now() + sec * 1000;
    } else if (atRaw !== undefined) {
      const ms = Date.parse(atRaw);
      if (!Number.isFinite(ms) || ms <= Date.now()) {
        fail(`--at must be a valid ISO datetime in the future (got: ${atRaw})`);
      }
      body.schedule_kind = "once";
      body.run_at = ms;
    }

    if (repeatRaw !== undefined) {
      if (repeatRaw === "0" || repeatRaw === "\u221E" || repeatRaw.toLowerCase() === "infinite") {
        body.repeat_times = null;
      } else {
        const n = parseInt(repeatRaw, 10);
        if (!Number.isFinite(n) || n <= 0) fail(`--repeat must be a positive integer, 0, or \u221E (got: ${repeatRaw})`);
        body.repeat_times = n;
      }
    }

    const created = await api(agent, "POST", "/schedules", body);
    printJson(created);
    return;
  }

  if (sub === "update") {
    const id = rest[1];
    if (!id) usage("schedule update", "<id> [--every D] [--in D] [--at ISO] [--prompt T] [--name N] [--mode agent|message] [--agent A] [--repeat N] [--enabled true|false]");
    const body: Record<string, unknown> = {};
    const name = flagStr(flags, "name");            if (name !== undefined) body.name = name;
    const prompt = flagStr(flags, "prompt");        if (prompt !== undefined) body.prompt = prompt;
    const modeRaw = flagStr(flags, "mode");
    if (modeRaw !== undefined) {
      if (modeRaw !== "agent" && modeRaw !== "message") fail(`--mode must be "agent" or "message"`);
      body.mode = modeRaw;
    }
    const agentName = flagStr(flags, "agent");      if (agentName !== undefined) body.agent_name = agentName;
    const repeatRaw = flagStr(flags, "repeat");
    if (repeatRaw !== undefined) {
      if (repeatRaw === "0" || repeatRaw === "\u221E" || repeatRaw.toLowerCase() === "infinite") {
        body.repeat_times = null;
      } else {
        const n = parseInt(repeatRaw, 10);
        if (!Number.isFinite(n) || n <= 0) fail("--repeat must be a positive integer, 0, or \u221E");
        body.repeat_times = n;
      }
    }
    const enabledRaw = flagStr(flags, "enabled");
    if (enabledRaw !== undefined) body.enabled = enabledRaw !== "false" && enabledRaw !== "0";

    const everyRaw = flagStr(flags, "every");
    const inRaw = flagStr(flags, "in");
    const atRaw = flagStr(flags, "at");
    if (everyRaw !== undefined) {
      const sec = parseDuration(everyRaw);
      if (sec === null || sec < 30) fail("--every must parse to >= 30s");
      body.schedule_kind = "interval";
      body.interval_sec = sec;
    } else if (inRaw !== undefined) {
      const sec = parseDuration(inRaw);
      if (sec === null || sec <= 0) fail("--in must parse to a positive duration");
      body.schedule_kind = "once";
      body.run_at = Date.now() + sec * 1000;
    } else if (atRaw !== undefined) {
      const ms = Date.parse(atRaw);
      if (!Number.isFinite(ms) || ms <= Date.now()) fail("--at must be a valid ISO datetime in the future");
      body.schedule_kind = "once";
      body.run_at = ms;
    }

    if (Object.keys(body).length === 0) {
      fail("no fields to update — pass at least one of --every / --in / --at / --prompt / --name / --mode / --agent / --repeat / --enabled");
    }
    const data = await api(agent, "PATCH", route("/schedules/:id", id), body);
    printJson(data);
    return;
  }

  if (sub === "remove" || sub === "delete") {
    const id = rest[1]; if (!id) usage("schedule remove", "<id>");
    const data = await api(agent, "DELETE", route("/schedules/:id", id));
    printJson(data);
    return;
  }

  if (sub === "enable" || sub === "disable") {
    const id = rest[1]; if (!id) usage(`schedule ${sub}`, "<id>");
    const data = await api(agent, "PATCH", route("/schedules/:id", id), { enabled: sub === "enable" });
    printJson(data);
    return;
  }

  if (sub === "trigger") {
    const id = rest[1]; if (!id) usage("schedule trigger", "<id>");
    const data = await api(agent, "POST", route("/schedules/:id/trigger", id));
    printJson(data);
    return;
  }

  usage(
    "schedule",
    "<list|show|add|update|remove|enable|disable|trigger> [...]\n" +
    "  list                       [--group <id>] [--pretty]\n" +
    "  show <id>\n" +
    "  add    --group <id> --mode <agent|message> [--agent A] --prompt P\n" +
    "         ( --every <dur> | --in <dur> | --at <iso> ) [--name N] [--repeat N] [--enabled true|false]\n" +
    "  update <id> [--every D] [--in D] [--at ISO] [--prompt T] [--name N] [--mode M] [--agent A]\n" +
    "                   [--repeat N] [--enabled true|false]\n" +
    "  remove <id> | enable <id> | disable <id> | trigger <id>",
  );
}
