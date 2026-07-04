/**
 * master_node — 本机 master 的身份行(单行表)。
 *
 * 由 OPC bootstrap 在 master 启动时调用 `upsertMasterNode` 写入,
 * 包含 masterId(8 字符 base36,永远稳定)、hostname(显示用)、role 等。
 */

import type { MasterRole } from "../federation/identity.js";
import type { MeshDbSelf } from "./core.js";
import type { MasterNodeRow } from "./types.js";

export const masterNodeMethods = {
  getMasterNode(this: MeshDbSelf): MasterNodeRow | undefined {
    return this.db.prepare("SELECT * FROM master_node LIMIT 1").get() as MasterNodeRow | undefined;
  },

  /**
   * 写入或覆盖本机 master 身份行。表是单行的(LIMIT 1),
   * 调用方应保证一个进程只调一次(首次启动写入,之后只读)。
   */
  upsertMasterNode(
    this: MeshDbSelf,
    input: { id: string; hostname: string; role: MasterRole; displayName?: string; endpoint?: string; teamName?: string },
  ): void {
    const existing = this.db.prepare("SELECT id FROM master_node LIMIT 1").get() as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE master_node SET
          hostname = ?,
          role = ?,
          display_name = COALESCE(?, display_name),
          endpoint = COALESCE(?, endpoint),
          team_name = COALESCE(?, team_name),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        input.hostname,
        input.role,
        input.displayName ?? null,
        input.endpoint ?? null,
        input.teamName ?? null,
        existing.id,
      );
      return;
    }
    this.db.prepare(`
      INSERT INTO master_node (id, hostname, role, display_name, endpoint, team_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.hostname,
      input.role,
      input.displayName ?? null,
      input.endpoint ?? null,
      input.teamName ?? null,
    );
  },

  updateMasterRole(this: MeshDbSelf, role: MasterRole): void {
    this.db.prepare(
      "UPDATE master_node SET role = ?, updated_at = datetime('now') WHERE 1=1",
    ).run(role);
  },

  /** 本机 master 的 hostname —— 用于 agents 复合键查询时注入 hostname。 */
  getLocalHostname(this: MeshDbSelf): string | undefined {
    const row = this.db.prepare("SELECT hostname FROM master_node LIMIT 1").get() as { hostname: string } | undefined;
    return row?.hostname;
  },
};
