---
title: Agent White-box Prompts
description: Whiteboard-style image prompts for the Agent white-box architecture diagrams
---

# Agent White-box — Whiteboard-style Image Prompts

Companion doc: `docs/AGENT_WHITEBOX.md`

For generating whiteboard hand-drawn-style architecture diagrams. Prompts are in English; in-image text labels stay in Chinese.

---

## 1. Main prompt: full data flow (recommended)

Architecture overview for leadership. Emphasizes **rotom as a unified proxy layer that supports any CLI agent (claude / codex / aider)** — capturing their execution process for centralized storage and visualization.

```
Whiteboard-style flowchart, hand-drawn with marker pen on clean white background. Title "Agent 流程白盒化 - rotom 统一代理层" written in handwriting-style Chinese at top center.

Five sketched boxes arranged in a clear left-to-right flow with one branch downward:

Box 1 (left, blue accent, labeled "上层 Agent"): "openclaw / 其它编排 Agent"

Box 2 (center, red accent, larger and emphasized): "rotom 代理层 - 透传调用 · 捕获过程 · 持久化"

Box 3 (right, three small stacked sub-boxes under one bracket labeled "可兼容的 CLI Agent"):
  - "claude (stream-json)"
  - "codex"
  - "hermes / 其它"

Box 4 (bottom-center, green accent): "trace 存储"

Box 5 (far right, blue accent): "Dashboard 可视化 - 推理过程 / 工具调用 全可见"

Hand-drawn arrows:
- Box 1 → Box 2 labeled "spawn"
- Between Box 2 and Box 3 bracket: a pair of parallel hand-drawn arrows drawn close together to suggest a two-way pipe (NOT overlapping). The upper arrow points right (Box 2 → Box 3 bracket) labeled "调用 (透传不感知)". The lower arrow points left (Box 3 bracket → Box 2) labeled "白盒事件流: 推理 + 工具调用". Use different marker colors for the two arrows (e.g. black for upper, blue for lower) to visually distinguish direction.
- Box 2 → Box 4 (dotted) labeled "落盘 + 上报"
- Box 4 → Box 5 labeled "查询"

Highlighted callout sticky-note in yellow marker positioned at the bottom center of the image (well below all boxes, with clear spacing, NOT overlapping any other element). The sticky note is a wide rectangle containing two short lines of Chinese text on separate lines: line 1 "新增 CLI 只需加一个适配", line 2 "业务方零改动". Use large readable handwriting, keep generous padding inside the sticky note.

Boxes drawn with rough rectangular borders in black marker, slightly imperfect lines for authentic hand-drawn feel. Clean white background, multi-color markers (black outlines, blue/red/green/yellow accents). Educational diagram, minimal layout, only the essential message visible. No pens or drawing tools visible. 4K, crisp pen strokes.
```

**Diff from previous version**: nodes converged from 6 to 5; all implementation details (NDJSON / file paths / env vars / API paths) removed; CLI backends presented as a "pluggable list"; new "compatible / zero caller changes" callout; animation descriptions removed.

---

## 2. Concept cover: focus on the proxy core

Better as a section cover or PPT front page — uses a lightbulb + four bubbles to highlight rotom proxy's four jobs.

```
Whiteboard-style diagram with hand-drawn lightbulb at center, marker pen illustration. Glowing lightbulb sketched in black marker with yellow highlight, label "rotom 代理" beneath. Four speech bubbles around it containing Chinese text: "透传 - 业务方完全感知不到代理存在", "捕获 - CLI Agent 全量事件落盘", "兼容 - claude / codex / aider 等任意 CLI", "存储 - 本地优先 Master 异步聚合". Bubbles drawn as rough ellipses, connected with hand-drawn arrows forming circular flow around the lightbulb. Clean white background, multi-color marker accents (blue, red, green, yellow). Title "rotom 代理层 白盒化核心" at top in handwriting-style Chinese. Educational tone, minimal aesthetic, no pens or drawing tools visible. 4K, sharp pen strokes.
```

---

## 3. Comparison: visibility with vs without the proxy

Optional — emphasizes "why this proxy layer is needed".

```
Whiteboard-style comparison, hand-drawn down the middle dividing line on clean white background. Title "为什么需要 rotom 代理层" in handwriting-style Chinese at top.

Left side header "❌ 直接调用 claude" in red marker, showing sketched flow: "openclaw → claude" with a sad-face icon. Below in a sketched box: "Dashboard 只能看到 openclaw 成品输出 · claude 推理过程全部丢失 · 无法审计 · 无法复盘".

Right side header "✅ 经 rotom 代理" in green marker, showing sketched flow: "openclaw → rotom claude → claude" with a smiley-face icon. Below in a sketched box: "stream-json 全量捕获 · chat / tool_use / tool_result 全可见 · 父上下文自动挂载 · Dashboard 时间线可视化".

Big VS symbol drawn in center between two sides. Two columns of supporting hand-drawn icons (eye crossed out vs eye open). Clean white background, blue/red marker accents per side. Hand-drawn arrows, simple illustrations. Educational comparison diagram, minimal aesthetic, no pens or drawing tools visible. 4K, crisp.
```

---

## Usage tips

| Scenario | Pick |
|----------|------|
| Doc hero / architecture overview | 1 (full data flow) |
| PPT section cover / introducing the core idea | 2 (lightbulb bubbles) |
| Project kickoff / justifying the work | 3 (with vs without) |

Three images form a complete narrative: "why" (3) → "core idea" (2) → "how" (1).
