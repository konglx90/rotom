/**
 * Adapter helpers —— 多个 CLI 适配器(claude-code / codex / pi / hermes)共享的
 * 纯工具函数。
 *
 * Phase C 抽取原则(稳健):只下沉**逐字相同 / 行为确定同构**的逻辑。各 CLI 的
 * 协议解析(streaming JSON / JSON-RPC / ndjson / ACP)、stdout 行缓冲细节、
 * stderr 嗅探等差异点仍留在各自适配器,不强行模板化。
 *
 * 这里目前收两项:resolveSessionId(原 codex + claude-code 各一份,逐字相同)、
 * sliceTail(readSessionContent 的尾部切片,原 codex/claude/pi 三处相同)。
 */

/**
 * 决定最终对外上报的 sessionId。当请求 resume、但 CLI 实际吐出一个**不同的**新
 * sessionId 且本次执行失败时,说明 resume 没落地(CLI 打印 "No conversation
 * found..." 后新建了会话又失败退出)——返回空串让上层下次重开。
 *
 * codex 与 claude-code 原本各自维护一份逐字相同的实现,此处统一。
 */
export function resolveSessionId(
  requestedResume: string,
  emitted: string,
  failed: boolean,
): string {
  if (failed && requestedResume && emitted && emitted !== requestedResume) {
    return "";
  }
  return emitted;
}

/**
 * 取文本最后 N 行(不足 N 行则原样返回)。三个适配器(claude-code / codex / pi)
 * 的 readSessionContent 都用这同一段尾部切片逻辑渲染 session transcript。
 *
 * 注意:按 `\n` 切分后比较**行数**,不是字符数;空行也计入。
 */
export function sliceTail(text: string, tailLines: number): string {
  const lines = text.split("\n");
  return lines.length > tailLines ? lines.slice(-tailLines).join("\n") : text;
}
