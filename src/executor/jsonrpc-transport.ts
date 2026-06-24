/**
 * JSON-RPC 2.0 transport for executor CLI backends that speak the protocol
 * over stdio (codex app-server, hermes-cli acp_adapter).
 *
 * Owns:
 *   • pending-request map (id → resolver)
 *   • line framing from stdout
 *   • dispatch of responses / notifications / server-requests
 *
 * Does NOT own: process lifecycle (see process-runner.ts), stdin write
 * (we hand the caller a `send` function that wraps JSON + newline).
 */

import { createInterface, type Interface as RLInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export interface JsonRpcTransportOptions {
  /** Writable stream (proc.stdin) for outgoing JSON-RPC frames. */
  stdin?: Writable;
  /** Readable stream from which to parse JSON-RPC frames. Usually proc.stdout. */
  stdout: Readable;
  /** Called for every server→client request (method with id). */
  onRequest?: (method: string, params: unknown, id: number | string) => void;
  /** Called for every server→client notification (no id). */
  onNotification?: (method: string, params: unknown) => void;
  /** Called for every server→client response (matches a pending request). */
  onResponse?: (response: JsonRpcResponse) => void;
  /** Label used in log lines, e.g. `[codex]`. */
  label: string;
}

export interface JsonRpcTransport {
  /** Write a JSON-RPC frame to the child's stdin. */
  send: (msg: object) => void;
  /** Fire-and-forget notification (no id, no response expected). */
  notify: (method: string, params?: unknown) => void;
  /** Send a request and resolve when the matching response arrives. */
  request: (method: string, params?: unknown) => Promise<unknown>;
  /** Respond to a server-originated request. */
  respond: (id: number | string, result: unknown) => void;
  /** Respond to a server-originated request with an error. */
  respondError: (id: number | string, code: number, message: string) => void;
  /** Reject every pending request — call this when the underlying process dies. */
  rejectPending: (err: Error) => void;
  /** Auto-incrementing request id counter (exposed for executors that need it). */
  nextId: () => number;
}

/**
 * Build a JSON-RPC transport bound to `stdout` for incoming frames and
 * `stdin` (if provided) for outgoing writes.
 *
 * The caller still owns the underlying process — when it exits, call
 * `rejectPending` so any in-flight requests unblock with an error instead
 * of hanging forever.
 */
export function createJsonRpcTransport(opts: JsonRpcTransportOptions): JsonRpcTransport {
  const pending = new Map<number | string, PendingRpc>();
  let idCounter = 1;

  const nextId = (): number => idCounter++;

  const send = (msg: object) => {
    if (!opts.stdin || opts.stdin.destroyed) return;
    opts.stdin.write(JSON.stringify(msg) + "\n");
  };

  const notify = (method: string, params?: unknown) => {
    send({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const respond = (id: number | string, result: unknown) => {
    send({ jsonrpc: "2.0", id, result });
  };

  const respondError = (id: number | string, code: number, message: string) => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const rejectPending = (err: Error) => {
    for (const [id, p] of pending) {
      p.reject(err);
      pending.delete(id);
    }
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      console.warn(
        `[${opts.label}] Discarding malformed JSON-RPC frame: ${(err as Error).message}`,
      );
      return;
    }

    const hasId = "id" in parsed;
    const hasMethod = "method" in parsed;

    if (hasMethod && hasId) {
      // server → client request
      opts.onRequest?.(String(parsed.method), parsed.params, parsed.id as number | string);
      return;
    }
    if (hasMethod) {
      // server → client notification
      opts.onNotification?.(String(parsed.method), parsed.params);
      return;
    }
    if (hasId) {
      // response (success or error)
      const response = parsed as unknown as JsonRpcResponse;
      if (response.error) {
        const p = pending.get(response.id);
        if (p) {
          pending.delete(response.id);
          p.reject(new Error(`JSON-RPC ${p.method} failed: ${response.error.message}`));
        }
      } else {
        const p = pending.get(response.id);
        if (p) {
          pending.delete(response.id);
          p.resolve(response.result);
        }
      }
      opts.onResponse?.(response);
    }
  };

  const rl: RLInterface = createInterface({ input: opts.stdout });
  rl.on("line", handleLine);

  return {
    send,
    notify,
    request,
    respond,
    respondError,
    rejectPending,
    nextId,
  };
}