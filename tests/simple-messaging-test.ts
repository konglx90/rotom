/**
 * 简单测试: 创建两个测试 agents 来验证消息发送
 * 不干扰现有的"公司"和"小寿"agents
 *
 * 运行: node --import tsx tests/simple-messaging-test.ts
 */

import { randomUUID, createHash } from "node:crypto";
import { MeshDb } from "../src/master/db.js";
import WebSocket from "ws";

const DB_PATH = "/Users/kong/.openclaw/mesh-data/mesh.db";
const MASTER_URL = "ws://127.0.0.1:19800/ws";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function createTestAgents() {
  const db = new MeshDb(DB_PATH);

  // 创建两个测试 agents
  const token1 = "mesh_test_agent1_" + randomUUID().replace(/-/g, "");
  const token2 = "mesh_test_agent2_" + randomUUID().replace(/-/g, "");

  const id1 = randomUUID();
  const id2 = randomUUID();

  db.insertAgent({
    id: id1,
    name: "测试-Agent-1",
    description: "测试 Agent 1",
    domain: "测试",
    tokenHash: hashToken(token1),
  });

  db.insertAgent({
    id: id2,
    name: "测试-Agent-2",
    description: "测试 Agent 2",
    domain: "测试",
    tokenHash: hashToken(token2),
  });

  db.close();

  return { token1, token2, name1: "测试-Agent-1", name2: "测试-Agent-2" };
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
  console.log(`\n🔗 连接 ${name} 到 Master...`);

  const ws = new WebSocket(MASTER_URL);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("连接超时")), 5000);

    ws.on("open", () => {
      console.log(`✅ ${name} WebSocket 连接已建立`);
      clearTimeout(timeout);

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
        console.log(`📥 ${name} 收到:`, msg.type);

        if (msg.type === "auth_ok") {
          console.log(`✅ ${name} 认证成功`);
          resolve();
        }

        if (msg.type === "auth_failed") {
          reject(new Error(`认证失败: ${msg.reason}`));
        }
      } catch (err) {
        console.error(`❌ 解析消息失败:`, err);
      }
    });
  });

  return {
    ws,
    name,
    messages,
    send: (msg: any) => {
      ws.send(JSON.stringify(msg));
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

async function main() {
  console.log("========================================");
  console.log("  A2A Agent 消息发送测试");
  console.log("  使用独立测试 agents");
  console.log("========================================");

  // 创建测试 agents
  console.log("\n步骤 0: 创建测试 agents");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const { token1, token2, name1, name2 } = await createTestAgents();
  console.log(`✅ 创建了两个测试 agents: ${name1} 和 ${name2}`);

  let client1: TestClient | null = null;
  let client2: TestClient | null = null;

  try {
    // 连接
    console.log("\n步骤 1: 连接到 Master");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    client1 = await createTestClient(name1, token1, "测试 Agent 1");
    client2 = await createTestClient(name2, token2, "测试 Agent 2");

    await sleep(1000);

    // 测试 1: 发送消息
    console.log("\n步骤 2: 测试消息发送");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const requestId1 = `test-${Date.now()}-1`;
    client1.send({
      type: "a2a_send",
      requestId: requestId1,
      target: name2,
      payload: {
        message: `你好 ${name2}，我是 ${name1}，收到消息了吗？`,
      },
    });

    await waitFor(
      () => client2!.messages.some((m) => m.type === "a2a_message"),
      5000,
      `${name2} 收到消息`
    );

    const receivedMsg = client2.messages.find((m) => m.type === "a2a_message");
    console.log("\n✅ 消息发送成功:");
    console.log("   接收者:", receivedMsg?.from?.name);
    console.log("   内容:", receivedMsg?.payload?.message);
    console.log("   路由类型:", receivedMsg?.routeType);

    // 测试 2: 回复消息
    console.log("\n步骤 3: 测试消息回复");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    client2.send({
      type: "a2a_reply",
      requestId: requestId1,
      payload: {
        message: `收到啦！${name1} 你好～`,
      },
    });

    await waitFor(
      () => client1!.messages.some((m) => m.type === "a2a_message" && m.routeType === "reply"),
      5000,
      `${name1} 收到回复`
    );

    const replyMsg = client1.messages.find(
      (m) => m.type === "a2a_message" && m.routeType === "reply"
    );
    console.log("\n✅ 回复成功:");
    console.log("   发送者:", replyMsg?.from?.name);
    console.log("   内容:", replyMsg?.payload?.message);
    console.log("   路由类型:", replyMsg?.routeType);

    console.log("\n========================================");
    console.log("  ✅ 所有测试通过！");
    console.log("========================================");
    console.log("\n🎉 结论: A2A 消息发送和回复功能正常！");

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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
