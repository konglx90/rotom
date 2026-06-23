/**
 * rotom config — agent configuration management.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROTOM_CONFIG,
  ROTOM_HOME,
  loadRotomConfig,
  saveRotomConfig,
  resolveAgentFromEntry,
  expandHome,
  printJson,
  fail,
} from "./common.js";

export async function cmdConfig(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  const cfg = loadRotomConfig();
  cfg.agents = cfg.agents || {};

  if (sub === "show") {
    printJson({ configPath: ROTOM_CONFIG, ...cfg });
    return;
  }
  if (sub === "init") {
    if (fs.existsSync(ROTOM_CONFIG)) fail(`${ROTOM_CONFIG} already exists`);
    saveRotomConfig({ agents: {} });
    process.stdout.write(`Created ${ROTOM_CONFIG}\n`);
    return;
  }
  if (sub === "use") {
    const name = rest[1]; if (!name) fail("usage: rotom config use <name>");
    if (!cfg.agents?.[name]) fail(`agent "${name}" not registered`);
    cfg.defaultAgent = name; saveRotomConfig(cfg);
    process.stdout.write(`defaultAgent = ${name}\n`); return;
  }
  if (sub === "add-openclaw" || sub === "add-executor") {
    const name = rest[1]; const cfgPath = rest[2];
    if (!name || !cfgPath) fail(`usage: rotom config ${sub} <name> <path>`);
    const abs = path.resolve(expandHome(cfgPath));
    if (!fs.existsSync(abs)) fail(`config file not found: ${abs}`);
    const kind = sub === "add-openclaw" ? "openclaw" : "executor";
    cfg.agents[name] = { configPath: abs, kind };
    if (!cfg.defaultAgent) cfg.defaultAgent = name;
    saveRotomConfig(cfg);
    const resolved = resolveAgentFromEntry(name, cfg.agents[name]);
    process.stdout.write(`Registered ${name} (${kind}) → master=${resolved.master}\n`);
    return;
  }
  if (sub === "remove") {
    const name = rest[1]; if (!name) fail("usage: rotom config remove <name>");
    if (!cfg.agents[name]) fail(`agent "${name}" not registered`);
    delete cfg.agents[name];
    if (cfg.defaultAgent === name) delete cfg.defaultAgent;
    saveRotomConfig(cfg);
    process.stdout.write(`Removed ${name}\n`); return;
  }
  fail(`unknown config subcommand: ${sub || "(none)"}`);
}
