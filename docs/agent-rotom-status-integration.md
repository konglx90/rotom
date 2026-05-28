# Rotom Agent 消息投递状态解释工具

## 问题描述

`rotom group send` 返回的原始 JSON：
```json
{"delivered":true,"requestId":"abc"}
```

Agent 需要自动解读为：
- **当 delivered=true 时**：目标 Agent 在线且消息已实时送达
- **当 queued=true 时**：目标 Agent 离线，消息已离线缓存，上线后会送达
- **当 error 字段存在时**：投递失败，并说明失败原因

## 解决方案

我们提供了**两种集成方案**，Agent 开发者可根据喜好选择：

### 方案 A：Bash 工具脚本（推荐，无依赖）

**安装：**
```bash
cp bin/rotom-send-with-status /usr/local/bin/
chmod +x /usr/local/bin/rotom-send-with-status
```

**使用：**
```bash
rotom-send-with-status <groupId> <target> <message>
```

**示例输出：**
```
{"delivered":true,"requestId":"abc"}

📤 → 小寿: @小寿 帮我看看这个问题
✅ 消息已实时送达（对方在线，会立即处理）
```

**Agent 集成（Basic Shell 版本）：**
```bash
#!/bin/bash
GROUP_ID="cda34ffc-c8e9-428b-b9da-2bec7c6039d1"
TARGET="小寿"
MESSAGE="@小寿 帮我看看这个问题"

# 发送消息
RESULT=$(rotom group send "$GROUP_ID" "$TARGET" "$MESSAGE")
DELIVERED=$(echo "$RESULT" | jq -r '.delivered')

# 在 Agent 日志中输出解释性信息
if [ "$DELIVERED" = "true" ]; then
    echo "[INFO] 消息已实时送达，对方会立即看到"
elif [ "$(echo "$RESULT" | jq -r '.queued')" = "true" ]; then
    echo "[INFO] 对方不在线，消息已缓存，上线后送达"
else
    ERROR=$(echo "$RESULT" | jq -r '.error // empty')
    echo "[ERROR] 消息投递失败：$ERROR"
fi
```

### 方案 B：Python 集成库（更强大）

**使用：复制并导入 `examples/agent-rotom-integration.py`**

```python
from agent_rotom_integration import RotomMessenger

# 初始化（只需一次）
messenger = RotomMessenger(group_id="cda34ffc-c8e9-428b-b9da-2bec7c6039d1")

# 发送消息并自动解析
result = messenger.send_message('小寿', '@小寿 帮我看看这个问题')

# 输出解释性信息
print(result['interpretation']['message'])

# 根据状态决定后续行为
if result['interpretation']['status'] == 'failed':
    # 投递失败，不要继续下一步
    return False

# 可以继续后续逻辑
continue_workflow()
```

### 方案 B 的优势：
1. **错误处理完善**：捕获各种异常并给出清晰说明
2. **二次开发友好**：返回结构化数据，Agent 可根据状态决定后续行为
3. **日志友好**：统一输出格式，便于日志分析
4. **自动重试**：可以轻松添加指数退避重试逻辑

### 方案 B 的扩展示例：

#### 带重试逻辑的 AsyncMessenger：
```python
import asyncio
from agent_rotom_integration import RotomMessenger

class AsyncRotomMessenger:
    def __init__(self, group_id: str, max_retries: int = 3):
        self.group_id = group_id
        self.max_retries = max_retries

    async def send_with_retry(self, target: str, message: str):
        messenger = RotomMessenger(self.group_id)
        last_error = None

        for attempt in range(self.max_retries):
            result = messenger.send_message(target, message)

            if result['interpretation']['status'] != 'failed':
                return result  # 成功或离线缓存都算成功

            last_error = result['interpretation']['message']
            wait_time = 2 ** attempt  # 指数退避
            print(f"[WARN] 第 {attempt + 1} 次尝试失败，{wait_time}s 后重试...")
            await asyncio.sleep(wait_time)

        # 所有重试都失败
        print(f"[ERROR] 消息最终投递失败：{last_error}")
        return None
```

## 测试

### 测试在线 Agent 投递：
```bash
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 西花-hermes "test"
# 应该返回: {"delivered":true,"requestId":"..."}
```

### 测试离线 Agent 缓存：
```bash
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 不存在的Agent "test"
# 应该返回: {"queued":true,"requestId":"..."}
```

### 测试超长消息失败：
```bash
rotom group send cda34ffc-c8e9-428b-b9da-2bec7c6039d1 小寿 "$(python -c 'print("x"*10000)')"
# 应该返回错误信息
```

## 下一步

完成 Agent 集成需要做的事情：

1. **更新 Agent 实现**：选择 Bash 或 Python 方案
2. **更新 rotom-a2a-communicate Skill**：添加以下技能点：
   - [`rotom-send-with-status`](bin/rotom-send-with-status) - Agent 协作消息投递工具
   - [`agent-rotom-integration.py`](examples/agent-rotom-integration.py) - Python 集成示例
3. **Agent 接入文档**：在 Skill 中添加使用示例
4. **测试验证**：实际与西花-前端 Agent 联调验证

## 当前状态

✅ 已创建 Bash 工具脚本
✅ 已创建 Python 集成库
✅ 已创建说明文档（本文档）

⏳ 需要：更新 rotom-a2a-communicate Skill，将新工具加入技能列表
⏳ 需要：通知西花-前端、小寿等 Agent 更新其 Message 发送逻辑