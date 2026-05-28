/**
 * 测试"公司"和"小寿"两个 agents 之间的消息发送
 *
 * 运行方式:
 * node --import tsx tests/test-agent-messaging.ts
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const MASTER_URL = "ws://127.0.0.1:19800/ws"; // 使用正确的端口

// Agent tokens (需要从数据库或API获取)
// 这里我们假设使用已经存在的agents
const AGENT_GONGSI = "公司";
const AGENT_XIAOSHOU = "小寿";

// 测试用的token (需要替换为实际的token)
// 可以通过 POST /api/agents/{id}/refresh-token 获取
const TOKEN_GONGSI = process.env.TOKEN_GONGSI || "mesh_gongsi_token";
const TOKEN_XIAOSHOU = process.env.TOKEN_XIAOSHOU || "mesh_xiaoshou_token";

interface TestClient {
  ws: WebSocket;
  name: string;
  messages: any[];
  send: (msg: any) => void;
  close: () => void;
}

/**
 * 创建一个测试客户端连接到Master
 */
async function createTestClient(
  name: string,
  token: string,
  description?: string
): Promise<TestClient> {
  console.log(`\n🔗 连接 ${name} 到 Master...`);

  const ws = new WebSocket(MASTER_URL);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("连接超时")), 5000);

    ws.on("open", () => {
      console.log(`✅ ${name} WebSocket 连接已建立`);
      clearTimeout(timeout);

      // 发送认证消息
      const authMsg = {
        type: "auth",
        token,
        name,
        description,
        instance: {
          instanceId: randomUUID(),
          hostname: "test-host",
          platform: "test-platform",
        },
      };

      ws.send(JSON.stringify(authMsg));
      console.log(`📤 ${name} 发送认证消息`);
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        console.log(`📥 ${name} 收到消息:`, msg.type);

        // 认证成功后resolve
        if (msg.type === "auth_ok") {
          console.log(`✅ ${name} 认证成功`);
          console.log(`   当前在线 agents:`, msg.directory.map((d: any) => d.name));
          resolve();
        }
      } catch (err) {
        console.error(`❌ ${name} 解析消息失败:`, err);
      }
    });
  });

  return {
    ws,
    name,
    messages,
    send: (msg: any) => {
      const payload = JSON.stringify(msg);
      ws.send(payload);
      console.log(`📤 ${name} 发送:`, msg.type, msg.requestId || "");
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        console.log(`🔌 ${name} 连接已关闭`);
      }
    },
  };
}

/**
 * 等待条件满足
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  desc?: string
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `等待超时: ${desc || "条件未满足"} (${timeoutMs}ms)`
  );
}

/**
 * 睡眠
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 主测试流程
 */
async function main() {
  console.log("========================================");
  console.log("  A2A Agent 消息发送测试");
  console.log("  测试: 公司 ↔ 小寿");
  console.log("========================================");

  let client1: TestClient | null = null;
  let client2: TestClient | null = null;

  try {
    // ── 步骤 1: 连接两个 agents ────────────────────────────────
    client1 = await createTestClient(AGENT_GONGSI, TOKEN_GONGSI, "公司员工");
    client2 = await createTestClient(AGENT_XIAOSHOU, TOKEN_XIAOSHOU, "小寿员工");

    await sleep(1000); // 等待稳定

    // ── 步骤 2: 公司 → 小寿 发送消息 ───────────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("测试 1: 公司 → 小寿");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const requestId1 = `test-${Date.now()}-1`;
    client1.send({
      type: "a2a_send",
      requestId: requestId1,
      target: AGENT_XIAOSHOU,
      payload: {
        message: "你好小寿，我是公司，收到消息了吗？",
        timestamp: new Date().toISOString(),
      },
    });

    // 等待小寿收到消息
    await waitFor(
      () => client2!.messages.some((m) => m.type === "a2a_message"),
      5000,
      "小寿收到消息"
    );

    const receivedMsg = client2.messages.find((m) => m.type === "a2a_message");
    console.log("✅ 小寿收到消息:", receivedMsg?.payload);
    console.log("   发送者:", receivedMsg?.from?.name);
    console.log("   路由类型:", receivedMsg?.routeType);

    // 等待公司收到发送结果
    await waitFor(
      () => client1!.messages.some((m) => m.type === "route_result"),
      5000,
      "公司收到路由结果"
    );

    const routeResult = client1.messages.find((m) => m.type === "route_result");
    console.log("✅ 公司收到路由结果:", routeResult);

    if (!routeResult?.delivered) {
      throw new Error("消息未成功投递");
    }

    await sleep(1000);

    // ── 步骤 3: 小寿 → 公司 回复消息 ───────────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("测试 2: 小寿 → 公司 (回复)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    client2.send({
      type: "a2a_reply",
      requestId: requestId1, // 使用相同的 requestId 关联消息
      target: AGENT_GONGSI,
      payload: {
        message: "收到啦！我是小寿，你好公司～",
        timestamp: new Date().toISOString(),
      },
    });

    // 等待公司收到回复
    await waitFor(
      () => client1!.messages.some((m) => m.type === "a2a_message" && m.routeType === "reply"),
      5000,
      "公司收到回复"
    );

    const replyMsg = client1.messages.find(
      (m) => m.type === "a2a_message" && m.routeType === "reply"
    );
    console.log("✅ 公司收到回复:", replyMsg?.payload);
    console.log("   发送者:", replyMsg?.from?.name);
    console.log("   路由类型:", replyMsg?.routeType);

    await sleep(1000);

    // ── 步骤 4: 小寿 → 公司 发起新消息 ─────────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("测试 3: 小寿 → 公司 (新消息)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const requestId2 = `test-${Date.now()}-2`;
    client2.send({
      type: "a2a_send",
      requestId: requestId2,
      target: AGENT_GONGSI,
      payload: {
        message: "公司，今天天气不错啊～",
        timestamp: new Date().toISOString(),
      },
    });

    // 等待公司收到消息
    await waitFor(
      () => client1!.messages.some((m) => m.type === "a2a_message" && m.routeType !== "reply"),
      5000,
      "公司收到新消息"
    );

    const newMsg = client1.messages.find(
      (m) => m.type === "a2a_message" && m.routeType !== "reply"
    );
    console.log("✅ 公司收到新消息:", newMsg?.payload);
    console.log("   发送者:", newMsg?.from?.name);

    // ── 测试总结 ─────────────────────────────────────────────
    console.log("\n========================================");
    console.log("  ✅ 所有测试通过！");
    console.log("========================================");
    console.log("测试结果:");
    console.log("  ✅ 公司 → 小寿: 消息发送成功");
    console.log("  ✅ 小寿 → 公司: 回复成功");
    console.log("  ✅ 小寿 → 公司: 新消息发送成功");
    console.log("\n结论: 公司和 小寿 之间的双向通信正常！");

  } catch (err) {
    console.error("\n❌ 测试失败:", err);
    process.exit(1);
  } finally {
    // 清理连接
    console.log("\n🧹 清理连接...");
    client1?.close();
    client2?.close();
    await sleep(500);
  }
}

// 运行测试
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
