/**
 * JSON frame encode/decode helpers shared across the three transport sites
 * that previously each hand-rolled `JSON.stringify` / `JSON.parse`:
 *   - executor/jsonrpc-transport.ts (stdio newline-delimited JSON-RPC)
 *   - executor/worker-connection.ts  (agent-protocol WebSocket)
 *   - master/terminal-hub.ts         (browser xterm WebSocket)
 *
 * `encodeJsonLine` adds the trailing newline that the stdio JSON-RPC
 * transport needs; WS callers use plain `JSON.stringify` since the socket
 * is message-framed.
 *
 * `decodeJson` returns `undefined` on parse failure — callers decide whether
 * to silently drop (WS hubs) or log a warning (JSON-RPC transport with its
 * own labelled warn). Passing the raw Buffer through keeps a `toString()`
 * allocation out of the WS hot path.
 */

export function encodeJsonLine(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

export function decodeJson<T = unknown>(
  data: string | Buffer | ArrayBuffer | Buffer[],
): T | undefined {
  try {
    if (typeof data === "string") return JSON.parse(data) as T;
    if (Array.isArray(data)) return JSON.parse(Buffer.concat(data).toString()) as T;
    if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString()) as T;
    return JSON.parse(data.toString()) as T;
  } catch {
    return undefined;
  }
}
