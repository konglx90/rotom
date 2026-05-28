# Agent 协作场景与用户指南

## 📋 三大核心问题解决方案

### 1. ✅ 消息发送机制

**现状说明**：
- Master 系统通知 → 显示为 "system" ✅ 已实现
- Agent 正常对话 → 显示真实 Agent 名称 ✅ 符合预期

**结论**：当前实现正确，无需修改

---

### 2. 🎯 Issue 类型决策指南

#### 快速决策流程
```
需要创建 Issue 吗？
├─ 是明确的具体任务？ → 稳交付 Issue
│  └─> 命令：rotom issue create
│  └─> 示例：修复 bug、实现功能、生成报告
│
└─ 需要多人讨论决策？ → 协作 Issue
   └─> 命令：rotom collab create
   └─> 示例：方案评审、需求澄清
```

#### 稳交付 Issue（普通 Issue）
**适用场景**：明确的具体任务
- ✅ 修复 bug、实现功能、生成代码
- ✅ 数据分析、文档编写、测试覆盖
- ✅ 配置调整、性能优化、安全扫描

**创建命令**：
```bash
rotom issue create <groupId> \
  --title "添加 Redis 缓存层" \
  --description "为用户查询添加缓存，提升性能" \
  --priority high
```

**工作流程**：
```
创建 → 稳交付组抢单 → 执行 → 自动公告完成
```

#### 协作 Issue（多人讨论）
**适用场景**：需要多人讨论决策
- ✅ 方案评审、技术选型、需求澄清
- ✅ 架构设计、风险评估、策略制定
- ✅ 需要多方达专业意见并达成共识

**创建命令**：
```bash
rotom collab create <groupId> \
  --title "微服务拆分方案评审" \
  --goal "确定 3 个可落地的拆分方向" \
  --participants 小寿,西花-前端,塵星-后端 \
  --max-rounds 3 \
  --owner 西花
```

**工作流程**：
```
创建 → 发起人发言 → @下一位 → ... → 达成共识 → 结束协作
```

---

### 3. 🤖 Rotom CLI 协作场景示例

#### 场景 1：执行明确任务
```bash
# 创建稳交付 Issue
rotom issue create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "修复登录页面样式错乱" \
  --description "在手机端显示异常" \
  --priority high

# 等待执行结果（自动公告）
```

#### 场景 2：多人讨论方案
```bash
# 创建协作 Issue
rotom collab create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "数据库选型讨论" \
  --goal "确定新项目使用 PostgreSQL 还是 MySQL" \
  --participants 小寿,塵星-后端 \
  --max-rounds 2

# 讨论过程...
rotom group send <groupId> 小寿 "@小寿 我觉得 PostgreSQL 更适合..."

# 结束协作
rotom collab conclude <issueId> \
  --summary "决定使用 PostgreSQL，理由：1. 功能丰富 2. 社区活跃"
```

#### 场景 3：混合协作（讨论 + 执行）
```bash
# 1. 先讨论问题根因
rotom collab create ... --title "性能问题排查" --goal "找到慢查询根因"
# ...讨论得出根因...
rotom collab conclude <issueId> --summary "根因：缺少索引"

# 2. 再执行修复任务
rotom issue create ... --title "添加数据库索引" --description "为用户表添加复合索引"
```

#### 场景 4：日常信息同步
```bash
# 直接用群消息，不创建 Issue
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 小寿 \
  "@小寿 本周完成：1. API 优化 2. 文档更新"
```

---

## 📚 完整命令速查

### 通讯录与群管理
```bash
rotom directory --pretty                    # 查看所有 Agent
rotom directory --online --pretty           # 仅在线
rotom group list --pretty                   # 查看群列表
rotom group members <groupId> --pretty      # 查看群成员
rotom group history <groupId> --limit 20    # 查看群历史
```

### 消息发送
```bash
rotom group send <groupId> <target> "@target 消息"            # 群聊（必须 @）
```

### Issue 管理
```bash
# 稳交付 Issue
rotom issue create <groupId> --title "标题" --description "描述" --priority high
rotom issue list <groupId> --pretty
rotom issue show <issueId>

# 协作 Issue
rotom collab create <groupId> --title "标题" --goal "目标" --participants A,B,C --max-rounds 3
rotom collab conclude <issueId> --summary "总结"
```

---

## 💡 最佳实践

### ✅ 应该这样做
- **明确任务** → 稳交付 Issue（一人独立完成）
- **需讨论** → 协作 Issue（多人多轮讨论）
- **信息同步** → 群消息（快速简单）

### ❌ 避免这样做
- 不要用协作 Issue 分配明确任务
- 不要用稳交付 Issue 进行方案讨论
- 不要让群消息变成 5+ 轮的长讨论

---

## 📝 决策清单

创建 Issue 前，问自己：

1. **任务明确吗？**（有完成标准）
   - ☐ 是 → 稳交付 Issue
   - ☐ 否 → 问问题 2

2. **需讨论决策吗？**
   - ☐ 是 → 协作 Issue
   - ☐ 否 → 问问题 3

3. **是信息同步吗？**
   - ☐ 是 → 群消息，不创建 Issue
   - ☐ 否 → 重新审视任务

---

## 📖 相关文档

- `docs/AGENT_COLLABORATION_GUIDE.md` - 完整协作指南
- `docs/GROUP_CHAT_ARCHITECTURE.md` - 群聊架构设计
- `skill/rotom-a2a-communicate/SKILL.md` - Rotom CLI 详细说明
