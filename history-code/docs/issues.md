# E2ED Issues

## Issue-001: Metrics 时长始终为 0，评审状态始终为"需确认"

**发现日期**: 2026-06-07

### 问题描述

Pipeline 运行完成后，Dashboard 显示：
- Plan/Code 版本的「交付」和「评审」时长均为 `0.0s`
- 所有版本（Plan v1, Plan v2 等）的评审状态均为「需确认」

### 根因分析

有两个独立的断层：

#### 1. 时长始终为 0

`metrics.ts` 的 `findIssueDuration()` 通过匹配 `issue_events` 表中事件的 `metadata.phase` 和 `metadata.version` 来计算耗时。但没有任何代码写入这些字段：

| 事件来源 | event_type | metadata 含 phase/version? |
|----------|-----------|--------------------------|
| `db.createIssue()` | `created` | 否 — metadata 为空 |
| `claimNextIssue()` | `assigned` | 否 — metadata 为空 |
| `ws-hub.ts` issue_update → `addIssueEvent()` | `completed`/`failed`/`progress` | 否 — 只带 `artifacts`/`sessionId`/`cliTool` |

导致 `findIssueDuration()` 永远找不到匹配事件，返回 0。

**涉及文件**:
- `src/e2ed/metrics.ts` — `findIssueDuration()` 按 phase+version 过滤
- `src/master/db.ts` — `createIssue()` / `claimNextIssue()` 写事件时不带 phase/version
- `src/master/ws-hub.ts` — `issue_update` 透传 executor 的 metadata，不含 phase/version
- `src/executor/worker.ts` — `sendUpdate()` 只传 `{ artifacts, sessionId, cliTool }`

#### 2. 评审状态始终为"需确认"

`createPlanVersion()` 将 `reviewStatus` 初始化为 `null`，`computeMetrics()` 遇到 `null` 时默认显示 `'needs-review'`。

`updatePlanVersionStatus()` / `updateCodeVersionStatus()` 已定义但**从未被调用**。`sync.ts` 只推进需求的整体状态（如 `PLANNING → DELIVERED`），但未解析评审 agent 输出的 verdict 来回写版本级别的 `reviewStatus`。

**涉及文件**:
- `src/e2ed/requirement.ts` — 定义了 `updatePlanVersionStatus()` / `updateCodeVersionStatus()` 但未接入
- `src/e2ed/sync.ts` — 只处理整体需求状态机，不处理版本级 reviewStatus
- `src/e2ed/pipeline.ts` — import 了上述函数但不使用
- `src/e2ed/metrics.ts` — `pv.reviewStatus || 'needs-review'` 默认兜底

### 修复方向

1. 在创建 issue 时（`pipeline.ts` 的 `startDeliver`/`startReview`），将 `phase` 和 `version` 写入事件 metadata
2. 在 issue 完成时（`sync.ts` 或 `ws-hub.ts`），解析 review agent 返回的 verdict JSON，调用 `updatePlanVersionStatus()` / `updateCodeVersionStatus()` 回写 reviewStatus
