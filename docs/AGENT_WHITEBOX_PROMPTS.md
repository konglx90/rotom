# Agent 流程白盒化 - 白板风格图像提示词

配套文档:`docs/AGENT_WHITEBOX.md`

用于生成白板手绘风格的架构图。提示词为英文,图像中的文字标签保留中文。

---

## 一、主提示词:完整数据流图(推荐)

给老板看的架构总览。强调 **rotom 作为统一代理层,可兼容 claude / codex / aider 等任意 CLI agent**,把它们的执行过程白盒化后集中存储与可视化。

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

**与上一版的差别**:节点从 6 个收敛到 5 个、删了所有实现细节(NDJSON / 文件路径 / 环境变量 / API 路径),把 CLI 后端做成「可插拔列表」,新增「可兼容 / 业务方零改动」的卖点,去掉了动画描述。

---

## 二、概念封面图:聚焦代理核心

更适合做章节封面 / PPT 首页,用灯泡 + 四个气泡突出 rotom 代理的四件事。

```
Whiteboard-style diagram with hand-drawn lightbulb at center, marker pen illustration. Glowing lightbulb sketched in black marker with yellow highlight, label "rotom 代理" beneath. Four speech bubbles around it containing Chinese text: "透传 - 业务方完全感知不到代理存在", "捕获 - CLI Agent 全量事件落盘", "兼容 - claude / codex / aider 等任意 CLI", "存储 - 本地优先 Master 异步聚合". Bubbles drawn as rough ellipses, connected with hand-drawn arrows forming circular flow around the lightbulb. Clean white background, multi-color marker accents (blue, red, green, yellow). Title "rotom 代理层 白盒化核心" at top in handwriting-style Chinese. Educational tone, minimal aesthetic, no pens or drawing tools visible. 4K, sharp pen strokes.
```

---

## 三、对比图:有 / 无代理的可见度差异

可选,用来强调「为什么需要这层代理」。

```
Whiteboard-style comparison, hand-drawn down the middle dividing line on clean white background. Title "为什么需要 rotom 代理层" in handwriting-style Chinese at top.

Left side header "❌ 直接调用 claude" in red marker, showing sketched flow: "openclaw → claude" with a sad-face icon. Below in a sketched box: "Dashboard 只能看到 openclaw 成品输出 · claude 推理过程全部丢失 · 无法审计 · 无法复盘".

Right side header "✅ 经 rotom 代理" in green marker, showing sketched flow: "openclaw → rotom claude → claude" with a smiley-face icon. Below in a sketched box: "stream-json 全量捕获 · chat / tool_use / tool_result 全可见 · 父上下文自动挂载 · Dashboard 时间线可视化".

Big VS symbol drawn in center between two sides. Two columns of supporting hand-drawn icons (eye crossed out vs eye open). Clean white background, blue/red marker accents per side. Hand-drawn arrows, simple illustrations. Educational comparison diagram, minimal aesthetic, no pens or drawing tools visible. 4K, crisp.
```

---

## 使用建议

| 场景 | 选哪张 |
|------|--------|
| 文档头图 / 架构总览 | 一(完整数据流) |
| PPT 章节封面 / 介绍核心理念 | 二(灯泡气泡) |
| 项目立项 / 说服为什么要做 | 三(有无对比) |

三张图一套,从「为什么」(三) → 「核心理念」(二) → 「怎么做」(一),可组成完整叙事。
