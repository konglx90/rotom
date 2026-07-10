/**
 * Unit test — deriveAgentQueues(消息队列前端推断)
 *
 * Covers:
 *   - 空消息 / 无 demand → 返回 []
 *   - idle 发送:1 条 demand 无 turn → queued #1
 *   - turn 进行中:被当前 turn 覆盖的 demand → processing;turn 后发的 → queued
 *   - turn 结束后水合(stream 气泡被持久化消息替换):turnStarts ref 保留 turn 起点,
 *     让"turn 进行中发出的"消息不被持久化消息偏晚的 created_at 误判成已答
 *   - 合并:同一活跃 turn 覆盖的多条 demand → 全部 processing
 *   - DM 模式:无 @ 标记,所有发出消息当作对 directTarget 的 demand
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { deriveAgentQueues } from "../packages/dashboard/src/features/groups/agentQueue.js";
import type { ChatMessage } from "../packages/dashboard/src/features/groups/types.js";

const ME = "me";
const AGAN = "阿甘";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "from" | "isIncoming">): ChatMessage {
  return {
    content: partial.content ?? "",
    timestamp: partial.timestamp ?? new Date(0),
    isIncoming: partial.isIncoming,
    ...partial,
  } as ChatMessage;
}

/** 取某 agent 的 (state 列表 + queued 位次列表),方便断言。 */
function states(qs: ReturnType<typeof deriveAgentQueues>, agent: string) {
  const q = qs.find(x => x.agentName === agent);
  if (!q) return { states: [] as string[], positions: [] as (number | undefined)[], active: false };
  return {
    states: q.items.map(i => i.state),
    positions: q.items.filter(i => i.state === "queued").map(i => i.position),
    active: q.active,
  };
}

describe("deriveAgentQueues", () => {
  it("空消息列表 → []", () => {
    assert.deepEqual(deriveAgentQueues([], new Map(), ME), []);
  });

  it("idle 发送:无 turn → queued #1", () => {
    const messages = [msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 帮我查库存", mentions: [AGAN], timestamp: new Date(10) })];
    const qs = deriveAgentQueues(messages, new Map(), ME);
    const s = states(qs, AGAN);
    assert.deepEqual(s.states, ["queued"]);
    assert.deepEqual(s.positions, [1]);
    assert.equal(s.active, false);
  });

  it("turn 进行中:被当前 turn 覆盖 → processing;之后发的 → queued", () => {
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 第一条", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "s1", from: AGAN, isIncoming: true, content: "正在回", streaming: true, timestamp: new Date(11) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "@阿甘 第二条", mentions: [AGAN], timestamp: new Date(12) }),
    ];
    // ref 记录了 turn1 起点 = 11(首 chunk 到达时刻)。
    const turnStarts = new Map([[AGAN, [11]]]);
    const qs = deriveAgentQueues(messages, turnStarts, ME);
    const s = states(qs, AGAN);
    assert.equal(s.active, true);
    // m1 被 turn(11) 覆盖且活跃 → processing;m2 在 turn 之后发出 → queued #1
    assert.deepEqual(s.states, ["processing", "queued"]);
    assert.deepEqual(s.positions, [1]);
  });

  it("turn 结束后水合:turnStarts ref 保留起点,m2/m3 不被持久化消息误清", () => {
    // turn1 已结束:stream 气泡(s1)被替换成持久化 final(f1,created_at=14,晚于 m2/m3)。
    // 若只看 messages 的回复时间,m2(12)/m3(13) < 14 会被误判已答;靠 ref 里的 turn 起点(11)兜住。
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 第一条", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "@阿甘 第二条", mentions: [AGAN], timestamp: new Date(12) }),
      msg({ id: "m3", from: ME, isIncoming: false, content: "@阿甘 第三条", mentions: [AGAN], timestamp: new Date(13) }),
      msg({ id: "f1", from: AGAN, isIncoming: true, content: "回复第一条", timestamp: new Date(14) }),
    ];
    const turnStarts = new Map([[AGAN, [11]]]);
    const qs = deriveAgentQueues(messages, turnStarts, ME);
    const s = states(qs, AGAN);
    // m1 已被 turn(11)答过 → done(隐藏);m2/m3 仍排队
    assert.deepEqual(s.states, ["queued", "queued"]);
    assert.deepEqual(s.positions, [1, 2]);
    assert.equal(s.active, false);
  });

  it("合并:同一活跃 turn 覆盖的多条 demand → 全部 processing", () => {
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 一", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "@阿甘 二", mentions: [AGAN], timestamp: new Date(11) }),
      msg({ id: "s1", from: AGAN, isIncoming: true, content: "合并回复", streaming: true, timestamp: new Date(12) }),
    ];
    const turnStarts = new Map([[AGAN, [12]]]);
    const qs = deriveAgentQueues(messages, turnStarts, ME);
    const s = states(qs, AGAN);
    assert.deepEqual(s.states, ["processing", "processing"]);
    assert.deepEqual(s.positions, []);
  });

  it("active 但 turnStarts 还没记录首 chunk:队首 demand 提升为 processing", () => {
    // 刚发出去,loading 占位在(活跃)但首 chunk 未到 → ref 空。队首应标 processing 而非全 queued。
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 一", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "l1", from: AGAN, isIncoming: true, content: "", isLoading: true, timestamp: new Date(10) }),
    ];
    const qs = deriveAgentQueues(messages, new Map(), ME);
    const s = states(qs, AGAN);
    assert.equal(s.active, true);
    assert.deepEqual(s.states, ["processing"]);
  });

  it("DM 模式:无 @ 标记,所有发出消息当作对 directTarget 的 demand", () => {
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "第一条", timestamp: new Date(10) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "第二条", timestamp: new Date(11) }),
    ];
    const qs = deriveAgentQueues(messages, new Map(), ME, AGAN);
    const s = states(qs, AGAN);
    assert.deepEqual(s.states, ["queued", "queued"]);
    assert.deepEqual(s.positions, [1, 2]);
  });

  it("队列被消费完后 → 不返回该 agent(空 items 过滤)", () => {
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 一", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "f1", from: AGAN, isIncoming: true, content: "答完", timestamp: new Date(12) }),
    ];
    const turnStarts = new Map([[AGAN, [11]]]);
    const qs = deriveAgentQueues(messages, turnStarts, ME);
    // m1 被 turn(11)覆盖,但不活跃(turn 已结束)→ done → items 空 → agent 不出现
    assert.equal(qs.length, 0);
  });

  // ── 历史 bug 修复:打开群时,本会话之前已答完的旧消息不应显示为排队 ──
  // turnStarts ref 只记本会话发生的 live turn,历史 turn 没有记录。靠 messages 里的
  // 历史 reply 消息来判定"已答",否则所有旧消息都会被判成 queued(用户反馈的 bug)。

  it("纯历史(无 turnStarts):多条已被回复的消息 → 全不排队", () => {
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 一", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "f1", from: AGAN, isIncoming: true, content: "答一", timestamp: new Date(14) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "@阿甘 二", mentions: [AGAN], timestamp: new Date(20) }),
      msg({ id: "f2", from: AGAN, isIncoming: true, content: "答二", timestamp: new Date(25) }),
    ];
    const qs = deriveAgentQueues(messages, new Map(), ME);
    assert.equal(qs.length, 0);
  });

  it("纯历史:最后一条未被回复 → 只显示最后一条排队", () => {
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 一", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "f1", from: AGAN, isIncoming: true, content: "答一", timestamp: new Date(14) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "@阿甘 二", mentions: [AGAN], timestamp: new Date(20) }),
    ];
    const qs = deriveAgentQueues(messages, new Map(), ME);
    const s = states(qs, AGAN);
    assert.deepEqual(s.states, ["queued"]);
    assert.deepEqual(s.positions, [1]);
  });

  it("纯历史 rapid-fire 被一条合并回复答完 → 全不排队", () => {
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 一", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "@阿甘 二", mentions: [AGAN], timestamp: new Date(11) }),
      msg({ id: "m3", from: ME, isIncoming: false, content: "@阿甘 三", mentions: [AGAN], timestamp: new Date(12) }),
      msg({ id: "f1", from: AGAN, isIncoming: true, content: "合并答完", timestamp: new Date(20) }),
    ];
    const qs = deriveAgentQueues(messages, new Map(), ME);
    assert.equal(qs.length, 0);
  });

  it("live turn 已结束(F1 持久化),turn 进行中发的消息仍排队(不被 final 误清)", () => {
    // F1 的 final 消息(14)与 turnStart(11)配对、用起点 11,不会消费 turn 之后(12/13)发的消息。
    const messages = [
      msg({ id: "m1", from: ME, isIncoming: false, content: "@阿甘 一", mentions: [AGAN], timestamp: new Date(10) }),
      msg({ id: "m2", from: ME, isIncoming: false, content: "@阿甘 二", mentions: [AGAN], timestamp: new Date(12) }),
      msg({ id: "m3", from: ME, isIncoming: false, content: "@阿甘 三", mentions: [AGAN], timestamp: new Date(13) }),
      msg({ id: "f1", from: AGAN, isIncoming: true, content: "答一", timestamp: new Date(14) }),
    ];
    const turnStarts = new Map([[AGAN, [11]]]);
    const qs = deriveAgentQueues(messages, turnStarts, ME);
    const s = states(qs, AGAN);
    assert.deepEqual(s.states, ["queued", "queued"]);
    assert.deepEqual(s.positions, [1, 2]);
  });
});
