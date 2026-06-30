/**
 * E2ED — Prompt templates for three review types and delivery.
 * Ported from e2ed/src/lib/prompts.js
 */

import type { Verdict, DecisionContextEntry } from './types.js';

export function buildRequirementReviewPrompt(requirementText: string, reqTitle: string): string {
  return `你是独立需求评审人。你只做评审 — 不做任何修改。

## 需求标题
${reqTitle}

## 需求正文
${requirementText}

## 评审检查项
对每一项进行评估。给出 PASS 或 FAIL 并简要说明理由。

### 1. 清晰度（25%）
- [ ] 需求无歧义，有唯一解读
- [ ] 技术术语有定义且使用一致
- [ ] 范围边界明确说明（哪些在/不在范围内）
- [ ] 没有矛盾陈述

### 2. 完整性（25%）
- [ ] 所有功能需求均具体列出（不模糊）
- [ ] 非功能需求（性能、安全等）已提及
- [ ] 错误/边界情况有描述
- [ ] 对外部系统/接口的依赖已识别
- [ ] 用户角色和权限已指定

### 3. 可测试性（25%）
- [ ] 验收标准可量化、可验证
- [ ] 每条需求点可用具体测试用例验证
- [ ] 正常与异常输入的预期行为有说明
- [ ] 成功指标已定义

### 4. 歧义检查（25%）
- [ ] 没有使用"应该"、"可能"等模糊词语，需要时使用了"必须"
- [ ] 没有未指定的范围（"快"、"大"、"很多"等缺少具体数值）
- [ ] 没有不同读者可能有不同理解的隐含假设
- [ ] 没有遗漏"如果……怎么办"场景

## 输出格式
写出评审结果，然后以以下内容精确结尾：

VERDICT_JSON_START
{"score": <0-100>,"status": "<pass|fail|needs-review>","issues": ["..."],"suggestions": ["..."]}
VERDICT_JSON_END

评分标准: 80-100 pass | 50-79 needs-review | 0-49 fail`;
}

export function buildPlanReviewPrompt(requirementText: string, planText: string, planVersion: number): string {
  return `你是独立方案评审人。你只做评审 — 不做任何修改。

## 原始需求
${requirementText}

## 交付方案（v${planVersion}）
${planText}

## 评审检查项
对每一项进行评估。给出 PASS 或 FAIL 并简要说明理由。

### 1. 可行性（25%）
- [ ] 技术方案在所述约束下可行
- [ ] 依赖可用且兼容
- [ ] 预估复杂度与范围匹配
- [ ] 无不切实际的假设

### 2. 需求覆盖（25%）
- [ ] 方案覆盖了每条明确陈述的需求点
- [ ] 需求中提到的边界情况已处理
- [ ] 错误处理策略已定义
- [ ] 所有用户可见状态（加载、空、错误）已有规划

### 3. 风险评估（25%）
- [ ] 技术风险已识别并附带缓解策略
- [ ] 已评估对现有功能的潜在影响
- [ ] 性能影响已考虑
- [ ] 风险变更存在回滚策略

### 4. 方案质量（25%）
- [ ] 实施步骤具体且可执行
- [ ] 已识别文件/模块变更
- [ ] 数据模型变更已明确
- [ ] API 接口变更已定义
- [ ] 测试策略已概述

## 输出格式
写出评审结果，然后以以下内容精确结尾：

VERDICT_JSON_START
{"score": <0-100>,"status": "<pass|fail|needs-review>","issues": ["..."],"suggestions": ["..."]}
VERDICT_JSON_END

评分标准: 80-100 pass | 50-79 needs-review | 0-49 fail`;
}

export function buildCodeReviewPrompt(
  requirementText: string,
  planText: string,
  reflection: string,
  changedFiles: string[],
  diff: string,
  decisionContext?: DecisionContextEntry[],
): string {
  return `你是独立代码评审人。你只做评审 — 不做任何修改。

## 原始需求
${requirementText}

${formatDecisionContext(decisionContext)}
## 交付方案
${planText}

## 交付自反思
${reflection}

## 变更文件
${changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`).join('\n') : '（未检测到变更）'}

## 代码差异
${diff || '（无差异可用）'}

## 评审检查项
对每一项进行评估。给出 PASS 或 FAIL 并简要说明理由。

### 1. 需求覆盖
- [ ] 所有明确陈述的需求点已实现
- [ ] 边界情况和边界条件已处理
- [ ] 错误/异常处理完整
- [ ] 所有用户可见状态（加载、空、错误）已覆盖

### 2. 代码质量
- [ ] 无明显安全漏洞（XSS、注入、敏感数据）
- [ ] 命名/结构遵循项目约定
- [ ] 无冗余或死代码
- [ ] 无可配置的硬编码值

### 3. 边界校验（"两侧同时阅读"）
- [ ] API 接口定义与前端类型匹配
- [ ] 状态转换与 UI 行为一致
- [ ] 数据模型形态与业务逻辑匹配
- [ ] 模块间 Props/参数一致

### 4. 可维护性
- [ ] 无隐藏技术债引入
- [ ] 无过度抽象或过早优化
- [ ] 测试覆盖足够支持变更
- [ ] 注释说明 WHY 而非 WHAT

### 5. 需求偏差
- [ ] 实现与交付方案一致
- [ ] 自反思中的风险合理
- [ ] 无范围蔓延
- [ ] 方案偏差有合理依据

## 输出格式
写出评审结果，然后以以下内容精确结尾：

VERDICT_JSON_START
{"score": <0-100>,"status": "<pass|fail|needs-review>","issues": ["..."],"suggestions": ["..."]}
VERDICT_JSON_END

评分标准: 80-100 pass | 50-79 needs-review | 0-49 fail`;
}

export function buildDeliveryPrompt(requirement: string, planPath: string, reflectionPath: string, reviewFeedback?: string, planOnly?: boolean, decisionContext?: DecisionContextEntry[]): string {
  let prompt = `你是交付 Agent。完成以下需求并附带自反思。

## 需求
${requirement}

${formatDecisionContext(decisionContext)}
## 你的任务（按顺序执行）

### 阶段一：方案
1. 分析需求并理解代码库
2. 阅读现有文件，了解项目约定和模式
3. 将详细实施计划写入：${planPath}
   格式（按 markdown 编写）：
   - 需求摘要: 一段总结
   - 影响范围: 受影响的文件/模块
   - 技术方案: 具体的实施方案
   - 风险点: 潜在问题
   - 验收标准: 如何验证完成`;

  if (!planOnly) {
    prompt += `
${reflectionPath !== '/dev/null' ? `
### 阶段二：实现
1. 通过编辑代码文件实施方案
2. 遵循现有项目约定
3. 运行可用测试来验证

### 阶段三：反思
1. 将自反思写入：${reflectionPath}
   使用以下模板：
   # 交付自反思
   ## 关键决策（表格：决策 | 理由 | 备选方案）
   ## 不确定性与未知项
   ## 已知风险
   ## 与原始需求的偏差
   ## 变更的文件
   ## 我会采取不同做法的内容` : ''}`;
  } else {
    prompt += `

## 重要提示
这是一个仅方案的任务。不要实现任何代码或创建任何项目文件。
只写方案 markdown 文件。方案写完后停止。`;
  }

  prompt += `

## 约束
- 不要自我评估质量（那是评审人的工作）
- 先写方案再编码，而非相反
- 每次文件变更必须有意图`;

  if (reviewFeedback) {
    prompt += `

## 重要提示：需要修复
先前评审发现问题。修复下面指出的所有问题。不要从头开始。

### 评审反馈
${reviewFeedback}`;
  }

  return prompt;
}

/** Extract verdict JSON from review report text */
export function extractVerdict(text: string): Verdict {
  const m1 = text.match(/VERDICT_JSON_START\s*(\{[\s\S]*?\})\s*VERDICT_JSON_END/);
  if (m1) try { return normalizeVerdict(JSON.parse(m1[1])); } catch { /* fall through */ }

  const m2 = text.match(/```(?:verdict|json)?\s*(\{"score"[\s\S]*?\})\s*```/);
  if (m2) try { return normalizeVerdict(JSON.parse(m2[1])); } catch { /* fall through */ }

  const m3 = text.match(/\{"score"\s*:\s*\d+[\s\S]*?\}/);
  if (m3) try { return normalizeVerdict(JSON.parse(m3[0])); } catch { /* fall through */ }

  return { score: 0, status: 'needs-review', issues: ['Could not parse verdict'], suggestions: ['Manual review required'] };
}

function formatDecisionContext(ctx?: DecisionContextEntry[]): string {
  if (!ctx || ctx.length === 0) return '';
  const lines: string[] = ['## 决策上下文（来自前几轮）', ''];
  for (const entry of ctx) {
    const label = entry.phase.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`### ${label} v${entry.version}`);
    if (entry.issues.length > 0) {
      lines.push(`- 发现的问题: ${entry.issues.join('; ')}`);
    }
    if (entry.decisions.length > 0) {
      lines.push(`- 关键决策: ${entry.decisions.join('; ')}`);
    }
    if (entry.rejectedAlternatives?.length) {
      lines.push(`- 被拒绝的方案: ${entry.rejectedAlternatives.join('; ')}`);
    }
    if (entry.constraints?.length) {
      lines.push(`- 约束: ${entry.constraints.join('; ')}`);
    }
    lines.push('');
  }
  lines.push('请遵守以上所有约束。继续前确认先前的问题已解决。\n');
  return lines.join('\n');
}

function normalizeVerdict(v: any): Verdict {
  return {
    score: typeof v.score === 'number' ? v.score : 0,
    status: ['pass', 'fail', 'needs-review'].includes(v.status) ? v.status : 'needs-review',
    issues: Array.isArray(v.issues) ? v.issues : [],
    suggestions: Array.isArray(v.suggestions) ? v.suggestions : [],
  };
}

export const REFLECTION_TEMPLATE = `# 交付自反思

## 关键决策

| 决策 | 理由 | 备选方案 |
|------|------|--------|
| ... | ... | ... |

## 不确定性与未知项
- ...

## 已知风险
- ...

## 与原始需求的偏差
- ...

## 变更的文件
- ...

## 我会采取不同做法的内容
- ...
`;
