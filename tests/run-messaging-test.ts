/**
 * 测试"公司"和"小寿"之间的消息发送
 * 使用现有的 tokens，不会刷新或修改数据库
 *
 * 运行: node --import tsx tests/run-messaging-test.ts
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const MASTER_URL = "ws://127.0.0.1:19800/ws";

// 使用现有的 tokens
const TOKEN_GONGSI = "mesh_457ed7fab7d02ef21e4f8561d06bf60f";
const TOKEN_XIAOSHOU = "mesh_c10d54a96883c4883733ed363573bf01";

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
          const onlineAgents = msg.directory
            .map((d: any) => `${d.name}(${d.status === 'online' ? '在线' : '离线'})`)
            .join(", ");
          console.log(`   当前通讯录: ${onlineAgents}`);
          resolve();
        }

        // 处理认证失败
        if (msg.type === "auth_failed") {
          reject(new Error(`认证失败: ${msg.error}`));
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
  throw new Error(`等待超时: ${desc || "条件未满足"} (${timeoutMs}ms)`);
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
    console.log("\n步骤 1: 连接到 Master 服务");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    client1 = await createTestClient("公司", TOKEN_GONGSI, "公司员工");
    client2 = await createTestClient("小寿", TOKEN_XIAOSHOU, "小寿员工");

    await sleep(1000); // 等待稳定

    // ── 步骤 2: 公司 → 小寿 发送消息 ───────────────────────────
    console.log("\n步骤 2: 测试 公司 → 小寿 发送消息");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const requestId1 = `test-${Date.now()}-1`;
    client1.send({
      type: "a2a_send",
      requestId: requestId1,
      target: "小寿",
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
    console.log("\n✅ 小寿收到消息:");
    console.log("   内容:", receivedMsg?.payload?.message);
    console.log("   发送者:", receivedMsg?.from?.name);
    console.log("   路由类型:", receivedMsg?.routeType);
    console.log("   消息ID:", receivedMsg?.messageId);

    // 等待公司收到发送结果
    await waitFor(
      () => client1!.messages.some((m) => m.type === "route_result"),
      5000,
      "公司收到路由结果"
    );

    const routeResult = client1.messages.find((m) => m.type === "route_result");
    console.log("\n✅ 公司收到路由结果:");
    console.log("   投递状态:", routeResult?.delivered ? "✅ 已投递" : "❌ 未投递");
    console.log("   请求ID:", routeResult?.requestId);

    if (!routeResult?.delivered) {
      throw new Error("消息未成功投递");
    }

    await sleep(1000);

    // ── 步骤 3: 小寿 → 公司 回复消息 ───────────────────────────
    console.log("\n步骤 3: 测试 小寿 → 公司 回复消息");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    client2.send({
      type: "a2a_reply",
      requestId: requestId1, // 使用相同的 requestId 关联消息
      payload: {
        message: "收到啦！我是小寿，你好公司～",
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
    console.log("\n✅ 公司收到回复:");
    console.log("   内容:", replyMsg?.payload?.message);
    console.log("   发送者:", replyMsg?.from?.name);
    console.log("   路由类型:", replyMsg?.routeType);

    await sleep(1000);

    // ── 步骤 4: 小寿 → 公司 发起新消息 ─────────────────────────
    console.log("\n步骤 4: 测试 小寿 → 公司 发起新消息");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const requestId2 = `test-${Date.now()}-2`;
    client2.send({
      type: "a2a_send",
      requestId: requestId2,
      target: "公司",
      payload: {
        message: "公司，今天天气不错啊～",
        timestamp: new Date().toISOString(),
      },
    });

    // 等待公司收到消息
    await waitFor(
      () => client1!.messages.some((m) => m.type === "a2a_message" && m.routeType === "exact"),
      5000,
      "公司收到新消息"
    );

    const newMsg = client1.messages.find(
      (m) => m.type === "a2a_message" && m.routeType === "exact"
    );
    console.log("\n✅ 公司收到新消息:");
    console.log("   内容:", newMsg?.payload?.message);
    console.log("   发送者:", newMsg?.from?.name);
    console.log("   路由类型:", newMsg?.routeType);

    // ── 步骤 5: 测试错误处理 ───────────────────────────────────
    console.log("\n步骤 5: 测试错误处理 - 发送给不存在的 agent");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const requestId3 = `test-${Date.now()}-3`;
    client1.send({
      type: "a2a_send",
      requestId: requestId3,
      target: "不存在的agent",
      payload: {
        message: "这条消息应该失败",
      },
    });

    // 等待错误结果
    await waitFor(
      () => client1!.messages.some((m) => m.type === "route_result" && m.delivered === false),
      5000,
      "收到错误结果"
    );

    const errorResult = client1.messages.find(
      (m) => m.type === "route_result" && m.requestId === requestId3
    );
    console.log("\n✅ 正确处理了错误:");
    console.log("   投递状态:", errorResult?.delivered ? "已投递" : "未投递");
    console.log("   错误信息:", errorResult?.error || "目标不存在");

    // ── 测试总结 ─────────────────────────────────────────────
    console.log("\n========================================");
    console.log("  ✅ 所有测试通过！");
    console.log("========================================");
    console.log("\n📋 测试结果汇总:");
    console.log("  ✅ 公司 → 小寿: 消息发送成功");
    console.log("  ✅ 小寿 → 公司: 回复成功 (a2a_reply)");
    console.log("  ✅ 小寿 → 公司: 新消息发送成功 (a2a_send)");
    console.log("  ✅ 错误处理: 正确返回错误信息");
    console.log("\n🎉 结论: 公司和 小寿 之间的双向通信功能正常！");

  } catch (err) {
    console.error("\n❌ 测试失败:", err);
    process.exit(1);
  } finally {
    // 清理连接
    console.log("\n🧹 清理连接...");
    client1?.close();
    client2?.close();
    await sleep(500);
    console.log("✅ 测试完成，连接已关闭");
  }
}

// 运行测试
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
