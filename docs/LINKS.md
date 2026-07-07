# Links(链接)知识库

群聊里出现的 URL 被自动采集、归一、去重、溯源,供 link 巡检分类 + agent 检索复用。

## 1. 概念

agent 在群里发文档/仓库/博客链接,这些链接是有价值的"群知识资产"。master 在群消息入库后跑一个 inline hook(`link-collector`)抽 URL → 归一化(`url_norm`)→ 去重入库,并记录"在哪条消息、谁发的、上下文片段"。未分类的链接由 link-patrol 巡检员定期分类。

## 2. 数据模型

**`links`** —— 主表

| 列 | 含义 |
|---|---|
| `id` | UUID |
| `url_norm` | 归一化 URL,**UNIQUE**(去重键) |
| `url_raw` | 原始 URL |
| `host` | 域名 |
| `title` / `category` / `summary` | 分类结果(初始 NULL) |
| `created_at` / `updated_at` / `last_seen_at` | 时间戳 |

**`link_tags`** —— 多对多标签 `(link_id, tag)`

**`link_occurrences`** —— 出现记录(provenance)

| 列 | 含义 |
|---|---|
| `link_id` | 关联链接 |
| `source_type` | 来源类型(`group_message`) |
| `source_id` / `source_group_id` / `source_sender` | 来源群消息 id / 群 / 发送者 |
| `context_snippet` | 出现处的文本片段 |
| `occurred_at` | 时间 |

**`link_source_groups`** —— 多对多"该链接在哪些群出现过"

## 3. 采集路径(inline hook)

```
群消息入库 (POST /groups/:id/messages 或 WS a2a_send)
  → collectLinksFromText(content, {sourceType, sourceId, sourceGroupId, sourceSender}, db)
      → extractUrls + normalizeUrl(去 query/fragment/尾斜杠等)
      → 命中已有 link(url_norm):addLinkOccurrence + touchLinkLastSeen + addLinkSourceGroup
      → 新 link:createLink + addLinkOccurrence + addLinkSourceGroup
```

采集失败不影响主消息路径(try/catch 兜底)。

## 4. 关键文件

- `src/master/services/link-collector.ts` —— 采集入口
- `src/shared/url-extractor.ts` —— `extractUrls` / `normalizeUrl` / `extractContextSnippet`(纯函数,`tests/url-extractor.test.ts` 19 用例覆盖)
- `src/master/db/links.ts` —— 主表 / occurrence / tags / source groups / patrol run-log CRUD
- `src/master/api/links.ts` —— 抽取 / 列表 / 详情 / patch 分类 REST

## 5. 与其他子系统关系

- **Patrol**:link-patrol 巡检员扫 `listUnclassifiedLinks` → 分类 → `updateLinkClassification` 写回。
- **Memory**:link 巡检分类结论可写 memory。
- **Dashboard**:工具箱"Link 分类"Tab 展示未分类/已分类链接。
