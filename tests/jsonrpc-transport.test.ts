import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { createJsonRpcTransport } from "../src/executor/jsonrpc-transport.js";

/**
 * jsonrpc-transport is a pure stdio protocol layer — test it with a
 * pair of in-memory streams instead of spawning a real CLI.
 *
 *   server stream (input for stdout)  ──> transport.onLine dispatch
 *   transport.send / request output    ──> client stream (output from stdin)
 */

function makeServerStream(input: string): { stream: Readable; read: () => string } {
  const stream = new Readable({ read() {} });
  stream.push(input);
  stream.push(null);
  return { stream, read: () => input };
}

function makeClientStream(): { stream: Writable; written: () => string[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return { stream, written: () => chunks.map((c) => c.toString()) };
}

test("jsonrpc-transport: request → response pairing resolves the promise", async () => {
  const serverOut = new Readable({ read() {} });
  const clientIn = makeClientStream();

  const responses: unknown[] = [];
  const transport = createJsonRpcTransport({
    stdin: clientIn.stream,
    stdout: serverOut,
    label: "test",
    onResponse: (r) => responses.push(r),
  });

  // Attach the await machinery BEFORE pushing data, then push.
  const resultPromise = transport.request("initialize", { x: 1 });
  serverOut.push(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`,
  );
  serverOut.push(null);
  const result = await resultPromise;
  assert.deepEqual(result, { ok: true });
  assert.equal(responses.length, 1);
});

test("jsonrpc-transport: error response rejects with method-prefixed message", async () => {
  // Pre-build a deferred stream that we push to AFTER the transport is
  // wired up — this lets the test's `assert.rejects` attach its handler
  // before the readline emission causes the rejection. Otherwise Node 24's
  // unhandled-rejection detector fires before assert.rejects subscribes.
  const serverOut = new Readable({ read() {} });
  const clientIn = makeClientStream();

  const transport = createJsonRpcTransport({
    stdin: clientIn.stream,
    stdout: serverOut,
    label: "test",
  });

  const assertion = assert.rejects(
    transport.request("initialize"),
    /initialize failed: bad/,
  );

  // Push the error response after the await machinery is attached.
  serverOut.push(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } })}\n`,
  );
  serverOut.push(null);
  await assertion;
});

test("jsonrpc-transport: server notification does NOT enter pending map", async () => {
  const serverOut = new Readable({ read() {} });
  const clientIn = makeClientStream();

  const notifications: Array<{ method: string; params: unknown }> = [];
  const transport = createJsonRpcTransport({
    stdin: clientIn.stream,
    stdout: serverOut,
    label: "test",
    onNotification: (m, p) => notifications.push({ method: m, params: p }),
  });

  // First push: a notification (no id, no pending entry).
  serverOut.push(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started" })}\n`);
  // Wait for the notification to be processed, then send a request.
  await new Promise((r) => setTimeout(r, 10));
  const requestPromise = transport.request("ping");
  serverOut.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  serverOut.push(null);
  const result = await requestPromise;
  assert.deepEqual(result, {});
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "turn/started");
});

test("jsonrpc-transport: server request invokes onRequest with id", async () => {
  const serverOut = new Readable({ read() {} });
  const clientIn = makeClientStream();

  const requests: Array<{ method: string; id: number | string }> = [];
  const transport = createJsonRpcTransport({
    stdin: clientIn.stream,
    stdout: serverOut,
    label: "test",
    onRequest: (m, _p, id) => {
      requests.push({ method: m, id });
      transport.respond(id, { accepted: true });
    },
  });

  serverOut.push(
    `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "approval", params: { ok: 1 } })}\n` +
    `${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { accepted: true } })}\n`,
  );
  serverOut.push(null);

  // Wait for the onRequest callback to fire.
  await new Promise((r) => setTimeout(r, 20));
  const written = clientIn.written().join("");
  assert.match(written, /"id":7/);
  assert.match(written, /"accepted":true/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "approval");
});

test("jsonrpc-transport: rejectPending resolves all in-flight requests", async () => {
  const serverOut = makeServerStream(""); // never send a response
  const clientIn = makeClientStream();

  const transport = createJsonRpcTransport({
    stdin: clientIn.stream,
    stdout: serverOut.stream,
    label: "test",
  });

  const a = transport.request("a");
  const b = transport.request("b");
  transport.rejectPending(new Error("process died"));

  await assert.rejects(a, /process died/);
  await assert.rejects(b, /process died/);
});

test("jsonrpc-transport: malformed JSON is logged and dropped, not thrown", async () => {
  const serverOut = new Readable({ read() {} });
  const clientIn = makeClientStream();

  const transport = createJsonRpcTransport({
    stdin: clientIn.stream,
    stdout: serverOut,
    label: "test",
  });

  // First line is malformed; second line is a response to id=1.
  const resultPromise = transport.request("ping");
  serverOut.push(
    `not json at all\n` +
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 })}\n`,
  );
  serverOut.push(null);
  const result = await resultPromise;
  assert.equal(result, 42);
});

test("jsonrpc-transport: nextId auto-increments from 1", () => {
  const transport = createJsonRpcTransport({
    stdin: undefined,
    stdout: makeServerStream("").stream,
    label: "test",
  });
  assert.equal(transport.nextId(), 1);
  assert.equal(transport.nextId(), 2);
  assert.equal(transport.nextId(), 3);
});

test("jsonrpc-transport: send/notify on destroyed stdin is a no-op (no throw)", () => {
  const clientIn = makeClientStream();
  clientIn.stream.destroy();
  const transport = createJsonRpcTransport({
    stdin: clientIn.stream,
    stdout: makeServerStream("").stream,
    label: "test",
  });
  // These should not throw.
  transport.send({ jsonrpc: "2.0", method: "x" });
  transport.notify("y");
  assert.ok(true);
});
