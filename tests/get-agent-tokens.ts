/**
 * 获取 agents 的 tokens 用于测试
 *
 * 运行: node --import tsx tests/get-agent-tokens.ts
 */

import { randomUUID, createHash } from "node:crypto";
import { MeshDb } from "../src/master/db.js";

const DB_PATH = "/Users/kong/.openclaw/mesh-data/mesh.db"; // 使用正确的数据库路径

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function main() {
  const db = new MeshDb(DB_PATH);

  console.log("========================================");
  console.log("  获取 Agent Tokens");
  console.log("========================================\n");

  // 获取所有 agents
  const agents = db.listAgents();

  console.log(`找到 ${agents.length} 个 agents:\n`);

  agents.forEach((agent) => {
    console.log(`📌 ${agent.name}`);
    console.log(`   ID: ${agent.id}`);
    console.log(`   状态: ${agent.status}`);
    console.log(`   Token Hash: ${agent.token_hash?.substring(0, 16)}...`);
    console.log("");
  });

  // 查找"公司"和"小寿"
  const gongsi = db.getAgentByName("公司");
  const xiaoshou = db.getAgentByName("小寿");

  if (!gongsi || !xiaoshou) {
    console.error("❌ 未找到 '公司' 或 '小寿' agent");
    process.exit(1);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("目标 Agents:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\n公司:`);
  console.log(`  ID: ${gongsi.id}`);
  console.log(`  Token Hash: ${gongsi.token_hash}`);

  console.log(`\n小寿:`);
  console.log(`  ID: ${xiaoshou.id}`);
  console.log(`  Token Hash: ${xiaoshou.token_hash}`);

  // 生成新的测试 tokens（如果需要）
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("测试 Tokens (请设置环境变量):");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 生成简单的测试 tokens
  const tokenGongsi = "mesh_test_gongsi_" + randomUUID().substring(0, 8);
  const tokenXiaoshou = "mesh_test_xiaoshou_" + randomUUID().substring(0, 8);

  console.log(`\nexport TOKEN_GONGSI="${tokenGongsi}"`);
  console.log(`export TOKEN_XIAOSHOU="${tokenXiaoshou}"`);

  console.log("\n提示: 如果你使用现有的 agents，需要先更新它们的 tokens:");
  console.log(`  db.updateAgentToken("${gongsi.id}", hashToken("${tokenGongsi}"))`);
  console.log(`  db.updateAgentToken("${xiaoshou.id}", hashToken("${tokenXiaoshou}"))`);

  db.close();
}

main();
