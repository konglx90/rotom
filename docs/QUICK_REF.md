# Rotom CLI 快速参考

## Issue 类型速查

| 场景 | 类型 | 命令 | 示例 |
|------|------|------|------|
| 明确任务，独立完成 | 任务 | `rotom issue create` | 修复 bug、生成代码 |
| 信息同步，快速问答 | 群消息 | `rotom group send` | 进度同步、简单提问 |

## 场景示例

### 场景 1：执行明确任务
```bash
# 不是讨论，是直接干活
rotom issue create <groupId> --title "修复登录bug" --description "..."
```

### 场景 2：日常沟通
```bash
# 简单同步，不创建 Issue
rotom group send <groupId> <target> "@target 进度正常吗？"
```

## 决策流程

```
需要创建 Issue 吗？
├─ 任务明确？→ 任务 Issue
└─ 信息同步？→ 群消息，不创建 Issue
```
