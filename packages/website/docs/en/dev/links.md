# Links Knowledge Base

URLs posted in group chat are auto-collected, normalized, deduped, and provenance-tracked for link-patrol classification and agent retrieval.

## 1. Concept

Links an agent posts in group (docs/repos/blogs) are valuable "group knowledge assets". After a group message is persisted, master runs an inline hook (`link-collector`) that extracts URLs → normalizes (`url_norm`) → dedupes into the table, recording which message, who sent it, and the context snippet. Unclassified links are periodically classified by the link-patrol agent.

## 2. Data model

**`links`** — main table

| Column | Meaning |
|---|---|
| `id` | UUID |
| `url_norm` | normalized URL, **UNIQUE** (dedup key) |
| `url_raw` | original URL |
| `host` | domain |
| `title` / `category` / `summary` | classification (NULL initially) |
| `created_at` / `updated_at` / `last_seen_at` | timestamps |

**`link_tags`** — many-to-many tags `(link_id, tag)`

**`link_occurrences`** — occurrence records (provenance)

| Column | Meaning |
|---|---|
| `link_id` | linked link |
| `source_type` | `group_message` |
| `source_id` / `source_group_id` / `source_sender` | source msg id / group / sender |
| `context_snippet` | text snippet at the occurrence |
| `occurred_at` | time |

**`link_source_groups`** — many-to-many "which groups has this link appeared in"

## 3. Collection path (inline hook)

```
group message persisted (POST /groups/:id/messages or WS a2a_send)
  → collectLinksFromText(content, {sourceType, sourceId, sourceGroupId, sourceSender}, db)
      → extractUrls + normalizeUrl (strip query/fragment/trailing slash)
      → existing link (url_norm hit): addLinkOccurrence + touchLinkLastSeen + addLinkSourceGroup
      → new link: createLink + addLinkOccurrence + addLinkSourceGroup
```

Collection failure never breaks the main message path (try/catch guard).

## 4. Key files

- `src/master/services/link-collector.ts` — collection entry
- `src/shared/url-extractor.ts` — `extractUrls` / `normalizeUrl` / `extractContextSnippet` (pure; `tests/url-extractor.test.ts`, 19 cases)
- `src/master/db/links.ts` — main / occurrence / tags / source groups / patrol run-log CRUD
- `src/master/api/links.ts` — extract / list / get / patch classification REST

## 5. Relationships

- **Patrol**: link-patrol scans `listUnclassifiedLinks` → classifies → `updateLinkClassification`.
- **Memory**: classification conclusions can be written to memory.
- **Dashboard**: toolbox "Link 分类" tab shows unclassified/classified links.
