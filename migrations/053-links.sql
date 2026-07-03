-- 053: 智能链接收集分类管理 —— 链接主表 + 出现记录 + 标签 + 来源群 + 巡检 run/log。
--
-- 采集:inline hook 在消息发送路径(a2a_reply / a2a_reply_end / sendAsAgent / POST /groups/:id/messages)
-- 上调 collectLinksFromText(),每条 URL 规范化后 INSERT OR IGNORE 进 links,occurrence 累加。
-- 分类:link-patrol handler 每轮扫未分类链接 → 派 issue 给巡检员 agent → 终态解析写回 links.category/tags/title +
-- 合并写入 agent_memory(tags=link_classification)做 few-shot。

-- 链接主表:url_norm 唯一,dedup 用
CREATE TABLE IF NOT EXISTS links (
  id            TEXT PRIMARY KEY,
  url_norm      TEXT NOT NULL UNIQUE,
  url_raw       TEXT NOT NULL,
  title         TEXT,
  category      TEXT,
  summary       TEXT,
  host          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_category ON links(category);
CREATE INDEX IF NOT EXISTS idx_links_host ON links(host);
CREATE INDEX IF NOT EXISTS idx_links_unclassified ON links(last_seen_at) WHERE category IS NULL;
CREATE INDEX IF NOT EXISTS idx_links_updated ON links(updated_at DESC);

-- 标签 多对多
CREATE TABLE IF NOT EXISTS link_tags (
  link_id  TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (link_id, tag)
);

-- 出现记录(每个上下文一次)
CREATE TABLE IF NOT EXISTS link_occurrences (
  id                TEXT PRIMARY KEY,
  link_id           TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL,
  source_id         TEXT,
  source_group_id   TEXT,
  source_sender     TEXT,
  context_snippet   TEXT,
  occurred_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occurrences_link ON link_occurrences(link_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_group ON link_occurrences(source_group_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_occurred ON link_occurrences(occurred_at DESC);

-- 链接↔群 多对多(反查"这个群出现过哪些链接")
CREATE TABLE IF NOT EXISTS link_source_groups (
  link_id   TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  group_id  TEXT NOT NULL,
  PRIMARY KEY (link_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_link_source_groups_group ON link_source_groups(group_id);

-- 巡检 run/log(类比 issue_patrol_runs/logs)
CREATE TABLE IF NOT EXISTS link_patrol_runs (
  run_id                  TEXT PRIMARY KEY,
  patrol_group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  patrol_issue_id         TEXT,
  started_at              TEXT NOT NULL,
  finished_at             TEXT,
  candidates_scanned      INTEGER NOT NULL DEFAULT 0,
  candidates_classified   INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL,
  note                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_link_patrol_runs_group ON link_patrol_runs(patrol_group_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_link_patrol_runs_issue ON link_patrol_runs(patrol_issue_id);

CREATE TABLE IF NOT EXISTS link_patrol_logs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES link_patrol_runs(run_id) ON DELETE CASCADE,
  link_id         TEXT,
  category        TEXT NOT NULL,
  tags            TEXT,
  title           TEXT,
  rationale       TEXT,
  raw             TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_patrol_logs_run ON link_patrol_logs(run_id);

-- Seed link-patrol-rules skill(固定 id 便于 bootstrap 按 id/name 绑定)
INSERT OR IGNORE INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
VALUES (
  'sk_link_patrol_rules_seed',
  'link-patrol-rules',
  '链接智能分类巡检规则:对候选链接给出 category/tags/title',
  '# 链接智能分类规则

你的任务:对每条候选链接给出 `category` + `tags[]` + `title` + `rationale`。
**不要**直接修改 links 表(只输出 JSON,系统会落库)。

## 分类目(category 单选,从下列选一个)

- `reference`     : 文档/规范/Wiki/参考资料
- `code`          : GitHub/GitLab/代码仓库 PR/Issue
- `tool`          : 工具/服务/产品官网
- `article`       : 博客/技术文章/教程
- `paper`         : 论文/研究报告
- `discussion`    : 论坛/HN/Reddit/Stack Overflow 讨论
- `issue-tracker` : 内部 Issue / 工单系统链接
- `media`         : 图片/视频/演示
- `other`         : 兜底

## Tags(自由字符串数组,推断规则)

按 host + path 关键词推断,例:
- react 官方文档 → `["react", "hooks"]`
- anthropic SDK 仓库 → `["anthropic", "claude-api", "sdk"]`
- pnpm monorepo 文档 → `["pnpm", "monorepo"]`

## Title 提取规则

- 优先用 context snippet 里 markdown `[text](url)` 的 text
- 否则用 url path 末段 + host(例:`react.dev/hooks → hooks · react.dev`)

## 输出格式

issue `result` 字段必须是 JSON 数组(用 markdown code block 包裹):

```json
[
  {
    "link_id": "<uuid>",
    "category": "reference",
    "tags": ["react", "hooks"],
    "title": "React Hooks 官方文档",
    "rationale": "react.dev 是官方域名,路径 /hooks 属参考资料"
  }
]
```

## 经验学习

本轮分类完成后,系统会把新规则合并写入 memory(下一轮作为 few-shot 自动注入 prompt)。
所以请尽量给出可复用的 rationale(描述 host + path 模式 → category 推断)。
',
  'patrol',
  'manual',
  NULL,
  'system:link-patrol-bootstrap',
  datetime('now'),
  datetime('now'),
  1,
  0,
  NULL
);
