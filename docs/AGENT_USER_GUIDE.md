# Agent 协作场景与用户指南

## 📋 两大核心问题解决方案

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
├─ 是明确的具体任务？ → 任务 Issue
│  └─> 命令：rotom issue create
│  └─> 示例：修复 bug、实现功能、生成报告
│
└─ 只是信息同步 / 简单提问？ → 群消息
   └─> 命令：rotom group send
```

#### 任务 Issue
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
创建 → Agent 抢单 → 执行 → 自动公告完成
```

---

### 3. 🤖 Rotom CLI 协作场景示例

#### 场景 1：执行明确任务
```bash
# 创建任务 Issue
rotom issue create cda34ffc-c8e9-428b-b9da-2bec7c6039d1 \
  --title "修复登录页面样式错乱" \
  --description "在手机端显示异常" \
  --priority high

# 等待执行结果（自动公告）
```

#### 场景 2：日常信息同步
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
# 任务 Issue
rotom issue create <groupId> --title "标题" --description "描述" --priority high
rotom issue list <groupId> --pretty
rotom issue show <issueId>
```

---

## 💡 最佳实践

### ✅ 应该这样做
- **明确任务** → 任务 Issue（一人独立完成）
- **信息同步** → 群消息（快速简单）

### ❌ 避免这样做
- 不要用任务 Issue 进行方案讨论（用群消息 + note 记录结论）
- 不要让群消息变成 5+ 轮的长讨论（升级为任务 Issue 承载）

---

## 📝 决策清单

创建 Issue 前，问自己：

1. **任务明确吗？**（有完成标准）
   - ☐ 是 → 任务 Issue
   - ☐ 否 → 问问题 2

2. **是信息同步吗？**
   - ☐ 是 → 群消息，不创建 Issue
   - ☐ 否 → 重新审视任务

---

## 📖 相关文档

- `docs/GROUP_CHAT_ARCHITECTURE.md` - 群聊架构设计
- `skill/rotom-a2a-communicate/SKILL.md` - Rotom CLI 详细说明
