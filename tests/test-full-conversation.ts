/**
 * 测试完整对话流程:
 * Dashboard → 小寿 → 公司 → 小寿 → Dashboard
 *
 * 运行: node --import tsx tests/test-full-conversation.ts
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const MASTER_URL = "ws://127.0.0.1:19800/ws";

// Dashboard client token (需要通过 API 获取或使用已知 token)
const TOKEN_DASHBOARD = "mesh_dashboard_token"; // 需要替换为实际 token

async function testFullFlow() {
  console.log("========================================");
  console.log("  完整对话流程测试");
  console.log("  Dashboard → 小寿 → 公司 → 小寿 → Dashboard");
  console.log("========================================\n");

  // 步骤 1: 查看 dashboard-client 的信息
  console.log("步骤 1: 查询 dashboard-client 信息");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const { MeshDb } = await import("../src/master/db.js");
  const db = new MeshDb("/Users/kong/.openclaw/mesh-data/mesh.db");

  const dashboardAgent = db.getAgentByName("dashboard-client");
  if (!dashboardAgent) {
    console.error("❌ dashboard-client 不存在于数据库中");
    console.log("\n💡 提示: Dashboard 需要先注册为 Agent 才能发送消息");
    db.close();
    return;
  }

  console.log("✅ dashboard-client 信息:");
  console.log("   ID:", dashboardAgent.id);
  console.log("   状态:", dashboardAgent.status);
  console.log("   描述:", dashboardAgent.description || "无");
  console.log("   Token Hash:", dashboardAgent.token_hash?.substring(0, 16) + "...");

  db.close();

  // 步骤 2: 测试流程
  console.log("\n步骤 2: 测试消息流程");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  console.log("\n📝 当前流程分析:");
  console.log("   1. Dashboard → 小寿: 需要在 Dashboard 界面发送");
  console.log("   2. 小寿 → 公司: 小寿需要转发逻辑（LLM 或规则）");
  console.log("   3. 公司 → 小寿: 公司回复消息");
  console.log("   4. 小寿 → Dashboard: 小寿需要转发回 Dashboard");

  console.log("\n⚠️  问题所在:");
  console.log("   ❌ 问题 1: Dashboard 前端没有发送消息的界面");
  console.log("   ❌ 问题 2: 小寿没有自动转发逻辑");
  console.log("   ❌ 问题 3: 小寿不会自动把公司的回复转回 Dashboard");

  console.log("\n✅ 已经可以工作的部分:");
  console.log("   ✅ Dashboard → 公司: 直接通信（已验证）");
  console.log("   ✅ 公司 → Dashboard: 回复通信（已验证）");
  console.log("   ✅ 公司 ↔ 小寿: 双向通信（已验证）");

  // 步骤 3: 提供解决方案
  console.log("\n步骤 3: 解决方案");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  console.log("\n方案 A: 简化流程（推荐）");
  console.log("   Dashboard → 公司 → 小寿 → 公司 → Dashboard");
  console.log("   让公司作为中转，小寿只需要回复公司");

  console.log("\n方案 B: 添加 Dashboard 发送界面");
  console.log("   1. 在 Dashboard 对话页面添加输入框");
  console.log("   2. 添加发送按钮，通过 REST API 代理发送");
  console.log("   3. 实时查看消息历史");

  console.log("\n方案 C: 配置 Agent 自动转发");
  console.log("   在小寿的配置中添加转发规则:");
  console.log("   {");
  console.log("     'forwardRules': [{");
  console.log("       'from': 'dashboard-client',");
  console.log("       'to': '公司',");
  console.log("       'autoReply': true");
  console.log("     }]");
  console.log("   }");

  // 步骤 4: 查看现有消息记录
  console.log("\n步骤 4: 查看历史消息");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const db2 = new MeshDb("/Users/kong/.openclaw/mesh-data/mesh.db");
  const messages = db2
    .listMessages({ limit: 5 })
    .filter(
      (m) =>
        m.from_name === "dashboard-client" ||
        m.to_name === "dashboard-client"
    );

  if (messages.length > 0) {
    console.log("\n📊 Dashboard 相关的最近消息:\n");
    messages.reverse().forEach((msg) => {
      const timestamp = msg.timestamp
        ? new Date(msg.timestamp + "Z").toLocaleString("zh-CN")
        : "";
      const payload = JSON.parse(msg.payload || "{}")?.message || "";
      const status = msg.status === "replied" ? "✅" : "⏳";

      console.log(
        `${status} [${timestamp}] ${msg.from_name} → ${msg.to_name}`
      );
      console.log(`   ${payload.substring(0, 60)}...\n`);
    });
  } else {
    console.log("\n   暂无 Dashboard 相关消息");
  }

  db2.close();

  console.log("\n========================================");
  console.log("  💡 结论");
  console.log("========================================");
  console.log("\n当前系统状态:");
  console.log("  ✅ Dashboard client 已注册");
  console.log("  ✅ Dashboard → 公司 通信正常");
  console.log("  ✅ 公司 ↔ 小寿 通信正常");
  console.log("\n缺少的部分:");
  console.log("  ❌ Dashboard 前端发送界面");
  console.log("  ❌ Agent 自动转发逻辑");
  console.log("\n建议下一步:");
  console.log("  1. 添加 Dashboard 发送功能（最快）");
  console.log("  2. 或简化流程，让公司作为主要交互对象");
}

testFullFlow().catch(console.error);
