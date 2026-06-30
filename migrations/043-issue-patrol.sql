-- 043: Issue 巡检 —— 主动出击 Phase 1 的日志表 + 默认规则 skill seed。
--
-- 巡检本身是 patrol 群里的一个 scheduled_tasks 行(handler_key='issue-patrol'),
-- 每小时跑一次,派一个 issue 给巡检员 agent,让它判断全局哪些 open issue 可以直接开工。
-- 本期只产日志,不改候选 issue 状态。
--
-- issue_patrol_runs: 每轮巡检一条,记录派出的 patrol issue + 节流计数 + 终态。
-- issue_patrol_logs: 每个候选 issue 一条,记录 verdict / 命中规则 / 理由。
-- 巡检员完成 patrol issue 后,_onIssueTerminal hook 解析 result JSON 落库。

CREATE TABLE IF NOT EXISTS issue_patrol_runs (
  run_id              TEXT PRIMARY KEY,
  patrol_group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  patrol_issue_id     TEXT,                          -- 本轮派给巡检员的 issue,NULL=未派发(节流跳过)
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  in_progress_count   INTEGER NOT NULL DEFAULT 0,    -- 本轮触发时全局 in_progress 数(不含巡检群自己)
  candidates_scanned  INTEGER NOT NULL DEFAULT 0,    -- 巡检员实际看过的候选数
  candidates_ready    INTEGER NOT NULL DEFAULT 0,    -- verdict=ready 的候选数
  status              TEXT NOT NULL,                  -- 'dispatched' | 'completed' | 'skipped_quota' | 'skipped_overlap' | 'agent_offline' | 'error'
  note                TEXT
);
CREATE INDEX IF NOT EXISTS idx_patrol_runs_group ON issue_patrol_runs(patrol_group_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_patrol_runs_patrol_issue ON issue_patrol_runs(patrol_issue_id);

CREATE TABLE IF NOT EXISTS issue_patrol_logs (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES issue_patrol_runs(run_id) ON DELETE CASCADE,
  patrol_group_id     TEXT NOT NULL,                  -- 冗余存一份,便于按巡检群过滤
  issue_id            TEXT,                           -- 候选 issue id;skipped 行为 NULL
  candidate_group_id  TEXT,                           -- 候选 issue 所属群
  verdict             TEXT NOT NULL,                  -- 'ready' | 'not_ready' | 'uncertain' | 'skipped'
  rule_matched        TEXT,                           -- 命中规则 e.g. "small-requirement" / "heavy-refactor"
  rationale           TEXT,                           -- 巡检员给的理由
  raw                 TEXT,                           -- JSON 快照(title/slash_command/priority/working_dir)
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patrol_logs_run ON issue_patrol_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_patrol_logs_patrol_group ON issue_patrol_logs(patrol_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patrol_logs_verdict ON issue_patrol_logs(verdict);
CREATE INDEX IF NOT EXISTS idx_patrol_logs_candidate_group ON issue_patrol_logs(candidate_group_id);

-- 默认规则 skill:巡检员据此判断"可直接认领"。可通过 rotom skill update 修改。
-- 用固定 id 便于在 POST /api/groups 建 patrol 群时按 id 绑定。
INSERT OR IGNORE INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
VALUES (
  'sk_issue_patrol_rules_seed',
  'issue-patrol-rules',
  'Issue 巡检规则:判断一个 open issue 是否可以直接认领开工',
  '# Issue 巡检规则

巡检员的任务:对每个候选 issue 给出 `verdict`(ready / not_ready / uncertain)和理由,
**不要**认领、分配、或操作任何候选 issue,只输出判断。

## 可直接认领 (verdict=ready) 的信号

满足以下任一即为 ready:

- **小需求**:改动范围 ≤ 2 个文件,不动 DB schema、不动 CI/部署配置
  - 信号:title 含「小改」「修」「补」「tweak」等,或 description 明确范围
- **出方案 / 调研**:产物是文档/markdown,不改业务代码
  - 信号:slash_command 含 `/plan` `/research` `/investigate`,title 含「调研」「方案」「设计」「评估」
- **纯文档 / 单测补充**:artifacts 预期是 .md 或 .test.ts,不动实现
  - 信号:title 含「文档」「补充测试」「补单测」

## 不建议认领 (verdict=not_ready) 的信号

满足以下任一即为 not_ready:

- **重构 / 跨模块改动**:影响 3+ 文件,或横跨多个领域模块
  - 信号:title 含「重构」「refactor」「迁移」「改造」
- **改 schema / 部署**:动 migrations、改 CI、动部署脚本
  - 信号:title 含「schema」「migration」「CI」「部署」「release」
- **依赖外部决策**:需要真人拍板、或依赖未完成的协作
  - 信号:description 里出现「等确认」「待拍板」「需要 X 先完成」

## 不确定 (verdict=uncertain)

信息不足、或规则都没命中时标 uncertain,rationale 说明缺什么信息。

## 输出格式

patrol issue 的 result 字段必须是 JSON 数组,每条:
```
{
  "issue_id": "<候选 id>",
  "verdict": "ready" | "not_ready" | "uncertain",
  "rule_matched": "<命中的规则名,如 small-requirement / heavy-refactor / 等>",
  "rationale": "<一句话理由>"
}
```
',
  'workflow',
  'manual',
  NULL,
  'system:patrol-bootstrap',
  datetime('now'),
  datetime('now'),
  1,
  0,
  NULL
);
