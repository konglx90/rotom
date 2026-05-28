/**
 * 模拟"公司"给"小寿"发送消息的测试脚本
 *
 * 运行: node --import tsx tests/test-gongsi-to-xiaoshou.ts
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const MASTER_URL = "ws://127.0.0.1:19800/ws";
const TOKEN_GONGSI = "mesh_457ed7fab7d02ef21e4f8561d06bf60f"; // 公司的 token

async function sendGongsiToXiaoshou() {
  console.log("========================================");
  console.log("  公司 → 小寿 消息发送测试");
  console.log("========================================\n");

  // 连接到 Master 作为"公司"
  console.log("🔗 以'公司'身份连接到 Master...");
  const ws = new WebSocket(MASTER_URL);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("连接超时")), 5000);

    ws.on("open", () => {
      console.log("✅ WebSocket 连接已建立");
      clearTimeout(timeout);

      // 认证为"公司"
      const authMsg = {
        type: "auth",
        token: TOKEN_GONGSI,
        name: "公司",
        description: "公司员工",
        instance: {
          instanceId: randomUUID(),
          hostname: "test-gongsi",
          platform: "test",
        },
      };

      ws.send(JSON.stringify(authMsg));
      console.log("📤 发送认证消息");
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        console.log(`📥 收到:`, msg.type);

        if (msg.type === "auth_ok") {
          console.log("✅ 认证成功");
          console.log(`   在线 agents:`, msg.directory.map((d: any) => d.name).join(", "));
          resolve();
        }

        if (msg.type === "auth_failed") {
          reject(new Error(`认证失败: ${msg.reason}`));
        }
      } catch (err) {
        console.error("❌ 解析消息失败:", err);
      }
    });
  });

  // 等待连接稳定
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 发送消息给"小寿"
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("发送消息给'小寿'");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const requestId = `test-gongsi-${Date.now()}`;
  const sendMsg = {
    type: "a2a_send",
    requestId,
    target: "小寿",
    payload: {
      message: "你好小寿，我是公司，这条消息是通过测试脚本发送的",
      timestamp: new Date().toISOString(),
    },
  };

  ws.send(JSON.stringify(sendMsg));
  console.log("📤 消息已发送:", sendMsg.payload.message);

  // 等待路由结果
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("等待路由结果超时")), 5000);

    const checkResult = () => {
      const result = messages.find((m) => m.type === "route_result" && m.requestId === requestId);
      if (result) {
        clearTimeout(timeout);
        if (result.delivered) {
          console.log("\n✅ 消息已成功投递到'小寿'！");
          console.log("   请求ID:", result.requestId);
        } else {
          console.log("\n❌ 消息投递失败");
          console.log("   错误:", result.error || "未知错误");
          console.log("   是否排队:", result.queued ? "是" : "否");
        }
        resolve();
      } else {
        setTimeout(checkResult, 100);
      }
    };

    checkResult();
  });

  // 保持连接一段时间，观察可能的消息
  console.log("\n⏳ 保持连接 5 秒，等待可能的回复...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 检查是否收到回复
  const replies = messages.filter((m) => m.type === "a2a_message" && m.routeType === "reply");
  if (replies.length > 0) {
    console.log("\n📨 收到回复:");
    replies.forEach((r) => {
      console.log("   来自:", r.from?.name);
      console.log("   消息:", r.payload?.message);
    });
  } else {
    console.log("\nℹ️  未收到回复（'小寿'可能没有自动回复功能）");
  }

  // 关闭连接
  console.log("\n🧹 关闭连接...");
  ws.close();
  console.log("✅ 测试完成");
}

// 执行测试
sendGongsiToXiaoshou().catch((err) => {
  console.error("\n❌ 测试失败:", err);
  process.exit(1);
});
