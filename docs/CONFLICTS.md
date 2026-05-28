# A2A Gateway 连接冲突问题分析

## 🔴 问题描述

当多个客户端使用**相同的 token** 连接到 Master 时，会发生连接替换，导致冲突。

## ⚠️ 冲突场景

### 场景 1: 测试脚本替换实际 Agent

```
时间线:
T1: 实际的"公司"在机器 A (ws://30.249.241.117:5577) 连接成功
T2: 测试脚本在机器 B 使用相同 token 连接
T3: Master 断开机器 A 的连接，接受机器 B 的连接
T4: 实际的"公司"失去连接，无法收发消息
T5: 测试脚本断开，Master 认为"公司"离线
```

### 场景 2: Reply 路由失败

```
1. 实际的"公司" (agentId=A) 发送消息给"小寿"
2. Master 记录: pendingRequests[requestId] = { fromAgentId: A }
3. 测试脚本以"公司"身份连接，获得新的 agentId=B
4. "小寿"尝试 reply，Master 查找 pendingRequests[requestId]
5. 返回 agentId=A，但此连接已断开
6. Reply 失败！
```

### 场景 3: 消息发送到错误的 Endpoint

```
1. "小寿"发送消息给"公司"
2. Master 查找"公司"的 WebSocket 连接
3. 找到测试脚本的连接（而不是实际的"公司"）
4. 消息被发送到测试脚本，而不是实际的"公司"
```

## 🔍 验证冲突

运行以下命令可以观察到冲突：

```bash
# 终端 1: 运行测试脚本
node --import tsx tests/test-gongsi-to-xiaoshou.ts

# 终端 2: 观察 Dashboard
# 刷新 http://localhost:19800/dashboard
# 观察"公司"的 endpoint 变化
```

你会看到：
- "公司"的 endpoint 从 `ws://30.249.241.117:5577` 变成测试脚本的地址
- 测试脚本结束后，"公司"变成离线状态

## ✅ 解决方案

### 方案 1: 使用专用测试 Agent（推荐）

创建独立的测试 agents，避免替换生产 agents：

```typescript
// 创建测试专用的 agents
const testAgent1 = "测试-公司-副本";
const testAgent2 = "测试-小寿-副本";
```

**优点**: 不影响生产环境
**缺点**: 无法测试真实的"公司"和"小寿"之间的通信

### 方案 2: 临时禁用生产 Agent

```bash
# 1. 停止实际的"公司" agent
# 2. 运行测试
# 3. 重启"公司" agent
```

**优点**: 可以测试真实场景
**缺点**: 需要手动干预，影响服务可用性

### 方案 3: 使用不同的测试 Token

为每个测试环境生成独立的 tokens：

```typescript
// 生产环境
const PROD_TOKEN = "mesh_457ed7fab7d02ef21e4f8561d06bf60f";

// 测试环境
const TEST_TOKEN = "mesh_test_gongsi_" + randomUUID();
```

需要在 Master 中添加 token 别名或多个 token 支持。

### 方案 4: 实现 Master 消息代理 API

添加一个 REST API 端点，让 Master 代理消息发送：

```http
POST /api/messages/send
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "from": "公司",
  "to": "小寿",
  "message": "消息内容",
  "force": true  // 强制发送，即使 agent 离线（使用离线队列）
}
```

**优点**: 不需要 WebSocket 连接
**缺点**: 需要修改 Master 代码

### 方案 5: 旁观模式 (Observer Mode)

让测试脚本只观察消息，不参与通信：

```typescript
// 使用 Master 的消息日志 API
GET /api/messages?agent=公司&limit=50
```

**优点**: 完全不影响生产环境
**缺点**: 只能查看，不能测试发送

## 🎯 当前建议

对于您的情况（测试"公司"和"小寿"的通信），建议：

1. **如果只是验证功能**: 使用方案 1（独立测试 agents）
   - 运行 `tests/simple-messaging-test.ts`
   - 已验证 A2A 消息功能正常 ✅

2. **如果需要测试真实场景**: 使用方案 2（临时禁用）
   - 暂停实际的"公司" agent
   - 运行测试脚本
   - 重启"公司" agent

3. **如果需要频繁测试**: 实现方案 4（Master API）
   - 需要开发，但最方便长期使用

## 📋 Master 连接管理

Master 的 WebSocket 连接管理规则：

1. **同名连接替换**: 后来的连接会替换先前的连接
2. **Agent ID 变化**: 每次连接会生成新的 instanceId，但 agentId (数据库 ID) 不变
3. **离线消息**: 未投递的消息会进入离线队列
4. **自动重连**: Agent 应该实现自动重连逻辑

## 🔧 实现建议

如果需要频繁测试而不影响生产环境，建议：

```typescript
// 在 Master 中添加测试模式
interface TestModeConfig {
  enabled: boolean;
  testTokens: Map<string, string>; // 生产 name -> 测试 token
}

// 测试时使用测试 token
const testConfig = db.getConfig("test_mode");
if (testConfig?.enabled) {
  const testToken = testConfig.testTokens.get("公司");
  // 使用 testToken 连接，不替换生产连接
}
```

## 📊 监控和诊断

通过 Dashboard 观察连接状态：

1. 查看员工列表中的 "Endpoint" 列
2. 观察 "在线时长" 是否突然重置
3. 查看消息统计，发现异常的接收/发送数量

```sql
-- 查询最近的连接变化
SELECT name, hostname, connected_at, last_heartbeat
FROM agents
WHERE status = 'online'
ORDER BY connected_at DESC;
```

## 🎬 最佳实践

1. **开发环境**: 使用独立的测试 agents
2. **测试环境**: 使用真实的 agents，但停止生产流量
3. **生产环境**: 避免使用测试脚本，只通过 Dashboard 观察
