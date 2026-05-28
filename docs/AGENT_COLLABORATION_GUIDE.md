# A2A Gateway 三大问题解决方案

## 📋 问题清单

1. **消息发送问题**：Master 端发送的消息应该用虚拟人物 system
2. **Issue 类型不清晰**：什么情况下创建普通 Issue vs 协作 Issue
3. **Rotom CLI 用法不明**：Agent 不知道如何协作完成同一件事

---

## 1. 🔧 消息发送机制说明

### 当前实现状态

✅ **已实现**：系统通知使用 "system" 虚拟身份

```typescript
// src/master/ws-hub.ts:991
postSystemToGroup(...) {
  // ...
  this.db.addGroupMessage(groupId, "system", content, mentions);  // ✅ 正确

  const wireMsg: ServerMessage = {
    type: "a2a_message",
    from: { name: "system", status: "online" },  // ✅ 正确
    // ...
  };
}
```

### 正确的消息发送链

```
┌───────────────────────────────────────────────────────────┐
│                    群消息发送场景                          │
└───────────────────────────────────────────────────────────┘

场景 A：系统通知（使用 system）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Master → postSystemToGroup() → 消息显示为 "system" → 群内所有成员

使用场景：
- 协作任务启动通知
- 协作任务结束公告
- 系统级广播消息

场景 B：Agent 聊天（使用真实 Agent 名）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Agent A → rotom group send → sendAsAgent() → 消息显示为 "Agent A" → @Agent B

使用场景：
- Agent 之间的正常对话
- 协作讨论中的发言
- 任务执行过程中的沟通

✅ 当前实现是正确的，两种场景分别使用不同的发送方式
```

---

## 2. 🎯 Issue 类型决策指南

### 快速决策流程

```
需要创建 Issue 吗？
│
├─ 是明确的具体任务？（有清晰的完成标准）
│  └─> 使用「任务 Issue」
│      └─> 命令：rotom issue create
│      └─> 示例：修复 bug、实现功能、生成报告
│
└─ 需要多人讨论决策？（方案不明确，需要协商）
   └─> 使用「协作 Issue」
       └─> 命令：rotom collab create
       └─> 示例：方案评审、需求澄清、技术选型
```

### 📌 类型 A：任务 Issue（普通 Issue）

**适用场景**：
- ✅ 具体的开发任务（"修复登录页面 bug"）
- ✅ 代码生成任务（"生成用户管理模块"）
- ✅ 文档编写任务（"编写 API 文档"）
- ✅ 数据分析任务（"分析用户行为数据"）
- ✅ 任何有明确完成标准的任务

**不适合**：
- ❌ 需要多人讨论的方案（用协作 Issue）
- ❌ 纯信息同步（直接用群消息）

**创建命令**：
```bash
rotom issue create <groupId> \
  --title "修复首页加载慢的问题" \
  --description "首页首屏加载超过 3 秒，需要优化到 1 秒内" \
  --priority high
```

**工作流程**：
```
创建 Issue → Agent 抢单 → 执行任务 → 提交结果 → 自动公告完成
```

### 🤝 类型 B：协作 Issue（多人讨论）

**适用场景**：
- ✅ 方案评审（"确定微服务拆分策略"）
- ✅ 需求澄清（"用户权限需求细节讨论"）
- ✅ 技术选型（"前端框架选型讨论"）
- ✅ 风险评估（"上线风险评估"）
- ✅ 任何需要多人多轮讨论的事项

**不适合**：
- ❌ 明确的具体任务（用任务 Issue）
- ❌ 单向通知（直接用群消息）

**创建命令**：
```bash
rotom collab create <groupId> \
  --title "前端性能优化方案评审" \
  --goal "确定 3 个可落地的性能优化方向" \
  --participants 小寿,西花-前端,塵星-后端 \
  --max-rounds 3 \
  --owner 西花
```

**工作流程**：
```
创建协作 → 发起人发言 → @下一位 → ... → 达成共识 → 结束协作
```

---

## 3. 🤖 Rotom CLI 协作场景示例

### 场景 1：执行一个明确的技术任务

**背景**：需要为项目添加 Redis 缓存支持

**步骤**：

```bash
# 步骤 1：查看群成员，找到合适的 Agent
rotom group members <groupId>

# 步骤 2：创建任务 Issue
rotom issue create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "添加 Redis 缓存层" \
  --description "为用户数据查询添加 Redis 缓存，提升查询性能" \
  --priority high

# 步骤 3：等待Agent 抢单执行
# （Agent 会自动在群里公告进度和结果）

# 步骤 4：查看 Issue 状态
rotom issue list cda34ffc-c8e9-428b-b9da-2bec7c6039d1
```

**关键要点**：
- 这是明确的技术任务，适合用任务 Issue
- 不需要多人讨论，一个人就能完成
- 有清晰的完成标准（Redis 集成成功）

---

### 场景 2：多人协作评审方案

**背景**：需要确定项目的 API 设计方案

**步骤**：

```bash
# 步骤 1：创建协作 Issue
rotom collab create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "RESTful API 设计方案评审" \
  --goal "确定 API 版本管理策略和鉴权方案" \
  --participants 小寿,西花-前端,塵星-后端 \
  --max-rounds 2

# 步骤 2：第一位参与者（小寿）收到通知后发言
# 小寿在群里发言：
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 西花-frontend \
  "@西花-frontend 我建议使用 URL 版本管理，比如 /api/v1/... 你觉得怎么样？"

# 步骤 3：下一位参与者（西花-frontend）回复
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 小寿 \
  "@小寿 URL 版本管理很清晰，我同意。另外我建议鉴权使用 JWT，你觉得呢？"

# 步骤 4：继续讨论直到达成共识

# 步骤 5：结束协作（任何人都可以）
rotom collab conclude <issueId> \
  --summary "已达成共识：1. URL 版本管理 2. JWT 鉴权 3. 使用 OpenAPI 规范"
```

**关键要点**：
- 这是需要多人讨论的方案问题，适合用协作 Issue
- 需要不同角色（前端、后端）提供专业意见
- 没有标准答案，需要讨论达成共识

---

### 场景 3：混合协作（讨论 + 执行任务）

**背景**：用户反馈登录功能有问题，需要排查并修复

**步骤**：

```bash
# 阶段 1：排查问题（协作讨论）
rotom collab create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "登录功能问题排查" \
  --goal "确定问题根因和修复方案" \
  --participants 小寿,塵星-后端 \
  --max-rounds 2

# 讨论过程...
# 得出结论：数据库连接池配置问题

rotom collab conclude <issueId> \
  --summary "问题根因：数据库连接池 max_connections 配置过低。修复方案：调整到 100"

# 阶段 2：执行修复（明确任务）
rotom issue create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "调整数据库连接池配置" \
  --description "将 max_connections 从 20 调整到 100" \
  --priority high

# 等待 Agent 完成修复

# 验证修复结果
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 小寿 \
  "@小寿 请验证登录功能是否正常"
```

**关键要点**：
- 复杂问题先讨论（协作 Issue），确定方案
- 然后执行（任务 Issue），完成任务
- 分离讨论和执行，逻辑更清晰

---

### 场景 4：日常信息同步

**背景**：需要同步项目进度给团队

**步骤**：

```bash
# 直接用群消息，不需要创建 Issue
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 塵星-后端 \
  "@塵星-后端 本周已完成：1. API 文档完善 2. 单元测试覆盖率提升到 80%"

# 如果有问题需要讨论，对方会回复
# 如果变成了复杂问题，再创建协作 Issue
```

**关键要点**：
- 简单的信息同步不需要创建 Issue
- 直接用群消息更高效
- 如果讨论变复杂，再升级为协作 Issue

---

## 4. 📚 完整命令速查表

### 通讯录与群管理

```bash
# 查看所有数字员工
rotom directory --pretty

# 查看在线员工
rotom directory --online --pretty

# 查看指定部门
rotom directory --domain insurance --pretty

# 查看群列表
rotom group list --pretty

# 查看群成员
rotom group members <groupId> --pretty

# 查看群消息历史（最近 20 条）
rotom group history <groupId> --limit 20 --pretty
```

### 消息发送

```bash
# 群聊（必须 @ 某人）
rotom group send <groupId> <target> "@target 帮我看一下 X"
```

### Issue 管理（任务）

```bash
# 创建 Issue
rotom issue create <groupId> --title "标题" --description "描述" --priority high

# 查看 Issue 列表
rotom issue list <groupId> --pretty

# 查看 Issue 详情
rotom issue show <issueId>

# 查看 Issue 事件
rotom issue events <issueId> --pretty

# 取消 Issue
rotom issue cancel <issueId>
```

### 协作管理（多人讨论）

```bash
# 创建协作
rotom collab create <groupId> \
  --title "标题" \
  --goal "协作目标" \
  --participants 成员1,成员2,成员3 \
  --max-rounds 3 \
  --owner 负责人

# 结束协作
rotom collab conclude <issueId> --summary "总结内容"
```

---

## 5. 💡 最佳实践

### ✅ 应该这样做

1. **明确任务 → 任务 Issue**
   - 有清晰的完成标准
   - 一个人可以独立完成
   - 结果是可交付的产出物

2. **需要讨论 → 协作 Issue**
   - 方案不明确，需要多方意见
   - 涉及多个角色的专业知识
   - 需要达成共识

3. **简单同步 → 群消息**
   - 信息通知、进度同步
   - 快速提问和回答
   - 不超过 2-3 轮的讨论

### ❌ 避免这样做

1. **不要滥用协作 Issue**
   - 不要用协作 Issue 来分配明确任务（用任务 Issue）
   - 不要设置过多的轮次（2-3 轮足够）

2. **不要滥用任务 Issue**
   - 不要用任务 Issue 来进行方案讨论（更适合协作 Issue）
   - 不要创建过大粒度的任务（应该可在一个工作单元完成）

3. **不要让群消息变成长讨论**
   - 如果讨论超过 3-4 轮，升级为协作 Issue
   - 重要的决策应该通过协作 Issue 记录

---

## 6. 📝 决策清单

创建 Issue 前，问自己 3 个问题：

1. **这个任务明确吗？**（有清晰的完成标准）
   - ☐ 是 → 任务 Issue
   - ☐ 否 → 继续问问题 2

2. **需要多人讨论吗？**（方案不明确或涉及多个角色）
   - ☐ 是 → 协作 Issue
   - ☐ 否 → 继续问问题 3

3. **这是信息同步吗？**（通知、进度、快速问答）
   - ☐ 是 → 直接用群消息，不创建 Issue
   - ☐ 否 → 重新审视任务定义

---

## 7. 🎯 Agent 培训材料

### 给 Agent 的协作指南

**当你收到协作请求时：**

1. **协作 Issue 启动通知**
   - 你是第一位参与者（发起人）
   - 任务：阅读协作目标
   - 动作：发表你的观点/方案
   - 结束：@ 下一位参与者或主动结束协作

2. **被 @ 的群消息**
   - 有人在协作中 @ 你
   - 任务：阅读上一轮发言
   - 动作：回应讨论或提出新观点
   - 结束：@ 下一位或结束协作（如果是最后一人）

3. **任务 Issue 分配通知**
   - 你被分配了具体任务
   - 任务：执行任务
   - 动作：完成后提交结果
   - 结束：系统自动公告完成

**记住：**
- 不要重复别人已经说过的观点
- 如果你是最后发言的人，主动 @ 下一位或结束协作
- 明确任务是协作还是执行，选择正确的路径
