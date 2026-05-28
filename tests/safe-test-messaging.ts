/**
 * 安全测试: 通过观察模式验证消息，不替换生产连接
 *
 * 运行: node --import tsx tests/safe-test-messaging.ts
 *
 * 此脚本只读取数据库中的消息日志，不建立 WebSocket 连接
 * 因此不会影响任何正在运行的 agents
 */

import { MeshDb } from "../src/master/db.js";

const DB_PATH = "/Users/kong/.openclaw/mesh-data/mesh.db";

function main() {
  const db = new MeshDb(DB_PATH);

  console.log("========================================");
  console.log("  安全模式: 查看消息日志");
  console.log("  不建立连接，不影响生产环境");
  console.log("========================================\n");

  // 获取最近的通信记录
  console.log("📊 最近的消息记录 (公司 ↔ 小寿):\n");

  const messages = db.listMessages({
    agent: "公司",
    limit: 20,
  });

  // 筛选出公司和 小寿之间的消息
  const relevantMessages = messages.filter(
    (m) =>
      (m.from_name === "公司" && m.to_name === "小寿") ||
      (m.from_name === "小寿" && m.to_name === "公司")
  );

  if (relevantMessages.length === 0) {
    console.log("ℹ️  暂无公司和 小寿之间的通信记录\n");
    console.log("💡 提示:");
    console.log("   1. 确保'公司'和'小寿'都在线");
    console.log("   2. 通过 LLM 工具调用让它们通信:");
    console.log("      mesh_send(target='对方名字', message='...')");
  } else {
    console.log(`找到 ${relevantMessages.length} 条消息记录:\n`);

    relevantMessages.reverse().forEach((msg, index) => {
      const timestamp = msg.timestamp
        ? new Date(msg.timestamp + "Z").toLocaleString("zh-CN")
        : "未知时间";

      let payload = "";
      try {
        payload = JSON.parse(msg.payload)?.message || msg.payload;
      } catch {
        payload = msg.payload || "";
      }

      const status =
        msg.status === "success"
          ? "✅"
          : msg.status === "failed"
          ? "❌"
          : "⏳";

      console.log(
        `${status} [${timestamp}] ${msg.from_name} → ${msg.to_name}`
      );
      console.log(`   路由类型: ${msg.route_type || "N/A"}`);
      console.log(`   方向: ${msg.direction}`);
      console.log(`   消息: ${payload.substring(0, 100)}`);
      if (msg.latency_ms) {
        console.log(`   延迟: ${(msg.latency_ms / 1000).toFixed(2)}s`);
      }
      console.log("");
    });
  }

  // 显示统计信息
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📈 通信统计:\n");

  const stats = db.agentMessageStats();
  const gongsiStats = stats.find((s) => s.name === "公司");
  const xiaoshouStats = stats.find((s) => s.name === "小寿");

  if (gongsiStats) {
    console.log("公司:");
    console.log(`  发送: ${gongsiStats.sent || 0} 条`);
    console.log(`  接收: ${gongsiStats.received || 0} 条`);
    console.log(`  回复: ${gongsiStats.replied || 0} 条`);
    console.log(
      `  失败: ${gongsiStats.failed || 0} 条`
    );
    if (gongsiStats.avg_latency_ms) {
      console.log(
        `  平均延迟: ${(Number(gongsiStats.avg_latency_ms) / 1000).toFixed(
          2
        )}s`
      );
    }
  }

  console.log("");

  if (xiaoshouStats) {
    console.log("小寿:");
    console.log(`  发送: ${xiaoshouStats.sent || 0} 条`);
    console.log(`  接收: ${xiaoshouStats.received || 0} 条`);
    console.log(`  回复: ${xiaoshouStats.replied || 0} 条`);
    console.log(
      `  失败: ${xiaoshouStats.failed || 0} 条`
    );
    if (xiaoshouStats.avg_latency_ms) {
      console.log(
        `  平均延迟: ${(Number(xiaoshouStats.avg_latency_ms) / 1000).toFixed(
          2
        )}s`
      );
    }
  }

  console.log("\n========================================");
  console.log("✅ 查询完成（未影响生产环境）");
  console.log("========================================");

  db.close();
}

main();
