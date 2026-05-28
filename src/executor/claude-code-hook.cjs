#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook bridge.
 *
 * claude spawns this script (one process per tool call) and feeds it a JSON
 * payload like:
 *   { "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "rm -rf …" } }
 * on stdin. The script forwards the payload to the unix-domain-socket server
 * the ClaudeCodeExecutor opened for this run, waits (possibly for minutes)
 * for the user's verdict, and prints the claude-shaped response JSON to
 * stdout:
 *   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *                              "permissionDecision": "allow" | "deny",
 *                              "permissionDecisionReason": "…" } }
 *
 * The socket path travels via the ROTOM_APPROVAL_SOCKET env var the executor
 * sets when spawning claude. A shared-secret token in ROTOM_APPROVAL_TOKEN
 * keeps stray local processes from injecting decisions.
 *
 * Fail-closed: if the socket is unreachable we deny the call. The executor
 * is the one place that should ever auto-allow, and it does that by simply
 * not configuring the hook (no settings.json, no socket).
 */

"use strict";

const http = require("node:http");

const socketPath = process.env.ROTOM_APPROVAL_SOCKET || "";
const token = process.env.ROTOM_APPROVAL_TOKEN || "";

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

if (!socketPath) {
  emitDeny("rotom approval bridge: ROTOM_APPROVAL_SOCKET not set");
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const req = http.request({
    socketPath,
    method: "POST",
    path: "/approval",
    headers: {
      "content-type": "application/json",
      "x-rotom-token": token,
    },
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { body += c; });
    res.on("end", () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        process.stdout.write(body);
        process.exit(0);
      } else {
        emitDeny(`rotom approval bridge: server returned ${res.statusCode}`);
      }
    });
  });
  req.on("error", (err) => {
    emitDeny(`rotom approval bridge: ${err.message}`);
  });
  req.write(raw);
  req.end();
});
process.stdin.on("error", (err) => {
  emitDeny(`rotom approval bridge: stdin error ${err.message}`);
});
