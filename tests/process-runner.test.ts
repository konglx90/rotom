import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/executor/process-runner.js";

/**
 * Smoke tests for the shared process-runner helper. These exercise the
 * happy path (clean exit) and the abort path (SIGTERM → KILL after grace).
 * No CLI backend required — we just spawn /bin/echo and /bin/sleep.
 */

test("runProcess captures exit code from a quick command", async () => {
  const handle = runProcess({
    bin: "/bin/echo",
    args: ["hello"],
    cwd: process.cwd(),
    label: "test",
  });

  let stdout = "";
  handle.proc.stdout?.on("data", (b: Buffer) => {
    stdout += b.toString();
  });

  const { exitCode } = await handle.done;
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), "hello");
});

test("runProcess propagates non-zero exit codes", async () => {
  const handle = runProcess({
    bin: "/bin/sh",
    args: ["-c", "exit 42"],
    cwd: process.cwd(),
    label: "test",
  });
  // Drain stdout/stderr to avoid backpressure hangs.
  handle.proc.stdout?.resume();
  handle.proc.stderr?.resume();

  const { exitCode } = await handle.done;
  assert.equal(exitCode, 42);
});

test("runProcess abort() kills the child promptly", async () => {
  const handle = runProcess({
    bin: "/bin/sleep",
    args: ["30"],
    cwd: process.cwd(),
    label: "test",
    graceMs: 500,
  });

  // Drain stdio so the child doesn't block on a full pipe buffer.
  handle.proc.stdout?.resume();
  handle.proc.stderr?.resume();

  const start = Date.now();
  handle.abort("test");
  const { exitCode } = await handle.done;
  const elapsed = Date.now() - start;

  // After abort the child should die within graceMs + a small margin.
  assert.ok(elapsed < 5000, `expected quick kill, took ${elapsed}ms`);
  // exitCode is non-zero on SIGTERM (128 + 15) or SIGKILL (128 + 9).
  assert.notEqual(exitCode, 0);
});

test("runProcess abort on already-aborted signal still kills the child", async () => {
  const ac = new AbortController();
  ac.abort();

  const handle = runProcess({
    bin: "/bin/sleep",
    args: ["30"],
    cwd: process.cwd(),
    label: "test",
    signal: ac.signal,
    graceMs: 200,
  });
  handle.proc.stdout?.resume();
  handle.proc.stderr?.resume();

  const { exitCode } = await handle.done;
  assert.notEqual(exitCode, 0);
});