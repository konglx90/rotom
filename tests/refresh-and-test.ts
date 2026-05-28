/**
 * 刷新 agents 的 tokens 并测试消息发送
 *
 * 运行: node --import tsx tests/refresh-and-test.ts
 */

import { randomUUID, createHash } from "node:crypto";
import { MeshDb } from "../src/master/db.js";
import WebSocket from "ws";

const DB_PATH = "/Users/kong/.openclaw/mesh-data/mesh.db";
const MASTER_URL = "ws://127.0.0.1:19800/ws";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function refreshTokensAndGetAgents() {
  const db = new MeshDb(DB_PATH);

  console.log("========================================");
  console.log("  刷新 Agent Tokens");
  console.log("========================================\n");

  const gongsi = db.getAgentByName("公司");
  const xiaoshou = db.getAgentByName("小寿");

  if (!gongsi || !xiaoshou) {
    console.error("❌ 未找到 '公司' 或 '小寿' agent");
    process.exit(1);
  }

  // 生成新的测试 tokens
  const tokenGongsi = `mesh_gongsi_${randomUUID().replace(/-/g, "").substring(0, 12)}`;
  const tokenXiaoshou = `mesh_xiaoshou_${randomUUID().replace(/-/g, "").substring(0, 12)}`;

  console.log("🔄 刷新 tokens...");
  console.log(`   公司: ${tokenGongsi}`);
  console.log(`   小寿: ${tokenXiaoshou}`);

  db.updateAgentToken(gongsi.id, hashToken(tokenGongsi));
  db.updateAgentToken(xiaoshou.id, hashToken(tokenXiaoshou));

  console.log("✅ Tokens 已更新到数据库\n");

  db.close();

  return { tokenGongsi, tokenXiaoshou };
}

interface TestClient {
  ws: WebSocket;
  name: string;
  messages: any[];
  send: (msg: any) => void;
  close: () => void;
}

async function createTestClient(
  name: string,
  token: string,
  description?: string
): Promise<TestClient> {
  console.log(`\n🔗 连接 ${name} 到 Master (${MASTER_URL})...`);

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
          console.log(`   当前在线 agents:`, msg.directory.map((d: any) => d.name).join(", "));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  // 刷新 tokens
  const { tokenGongsi, tokenXiaoshou } = await refreshTokensAndGetAgents();

  console.log("\n========================================");
  console.log("  开始消息测试");
  console.log("========================================");

  console.log("\n⚠️  注意: 由于刷新了 tokens，实际的 '公司' 和 '小寿' agents 会断开连接");
  console.log("    我们将创建新的测试连接来模拟这两个 agents\n");

  let client1: TestClient | null = null;
  let client2: TestClient | null = null;

  try {
    // 连接两个测试客户端
    client1 = await createTestClient("公司", tokenGongsi, "公司员工 (测试)");
    client2 = await createTestClient("小寿", tokenXiaoshou, "小寿员工 (测试)");

    await sleep(1000);

    // ── 测试 1: 公司 → 小寿 ───────────────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("测试 1: 公司 → 小寿");
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

    await waitFor(
      () => client2!.messages.some((m) => m.type === "a2a_message"),
      5000,
      "小寿收到消息"
    );

    const receivedMsg = client2.messages.find((m) => m.type === "a2a_message");
    console.log("✅ 小寿收到消息:", receivedMsg?.payload?.message);
    console.log("   发送者:", receivedMsg?.from?.name);
    console.log("   路由类型:", receivedMsg?.routeType);

    await waitFor(
      () => client1!.messages.some((m) => m.type === "route_result"),
      5000,
      "公司收到路由结果"
    );

    const routeResult = client1.messages.find((m) => m.type === "route_result");
    console.log("✅ 公司收到路由结果:", routeResult?.delivered ? "已投递" : "未投递");

    await sleep(1000);

    // ── 测试 2: 小寿 → 公司 (回复) ───────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("测试 2: 小寿 → 公司 (回复)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    client2.send({
      type: "a2a_reply",
      requestId: requestId1,
      target: "公司",
      payload: {
        message: "收到啦！我是小寿，你好公司～",
        timestamp: new Date().toISOString(),
      },
    });

    await waitFor(
      () => client1!.messages.some((m) => m.type === "a2a_message" && m.routeType === "reply"),
      5000,
      "公司收到回复"
    );

    const replyMsg = client1.messages.find(
      (m) => m.type === "a2a_message" && m.routeType === "reply"
    );
    console.log("✅ 公司收到回复:", replyMsg?.payload?.message);
    console.log("   发送者:", replyMsg?.from?.name);

    await sleep(1000);

    // ── 测试 3: 小寿 → 公司 (新消息) ─────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("测试 3: 小寿 → 公司 (新消息)");
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

    await waitFor(
      () => client1!.messages.some((m) => m.type === "a2a_message" && m.routeType === "exact"),
      5000,
      "公司收到新消息"
    );

    const newMsg = client1.messages.find(
      (m) => m.type === "a2a_message" && m.routeType === "exact"
    );
    console.log("✅ 公司收到新消息:", newMsg?.payload?.message);
    console.log("   发送者:", newMsg?.from?.name);

    // ── 总结 ──────────────────────────────────────────────
    console.log("\n========================================");
    console.log("  ✅ 所有测试通过！");
    console.log("========================================");
    console.log("\n🎉 结论: 公司和 小寿 之间的双向通信正常！\n");

  } catch (err) {
    console.error("\n❌ 测试失败:", err);
    process.exit(1);
  } finally {
    console.log("\n🧹 清理连接...");
    client1?.close();
    client2?.close();
    await sleep(500);
  }
}

runTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
