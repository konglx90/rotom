# Rotom CLI 快速参考

## Issue 类型速查

| 场景 | 类型 | 命令 | 示例 |
|------|------|------|------|
| 明确任务，独立完成 | 稳交付 | `rotom issue create` | 修复 bug、生成代码 |
| 多人讨论，达成共识 | 协作 | `rotom collab create` | 方案评审、需求澄清 |
| 信息同步，快速问答 | 群消息 | `rotom group send` | 进度同步、简单提问 |

## 协作场景示例

### 场景 1：执行明确任务
```bash
# 不是讨论，是直接干活
rotom issue create <groupId> --title "修复登录bug" --description "..."
```

### 场景 2：多人讨论方案
```bash
# 讨论决策，不是执行
rotom collab create <groupId> \
  --title "技术选型" \
  --goal "确定前端框架" \
  --participants A,B,C
```

### 场景 3：日常沟通
```bash
# 简单同步，不创建 Issue
rotom group send <groupId> <target> "@target 进度正常吗？"
```

## 决策流程

```
需要创建 Issue 吗？
├─ 任务明确？→ 稳交付 Issue
├─ 需讨论？→ 协作 Issue
└─ 信息同步？→ 群消息，不创建 Issue
```
