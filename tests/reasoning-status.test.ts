/**
 * Unit tests — Reasoning status helpers
 *
 * Covers:
 *   - extractFirstBold: simple pair, leading prose, unclosed opener, empty
 *     body, empty input, no bold
 *   - createReasoningStatusBuffer: dedupe across appends, reset behavior
 *   - emitStatus: tag format
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createReasoningStatusBuffer,
  emitStatus,
  extractFirstBold,
  STATUS_TAG_CLOSE,
  STATUS_TAG_OPEN,
} from "../src/executor/reasoning-status.js";

describe("extractFirstBold", () => {
  it("returns the inner text of a single bold pair", () => {
    assert.strictEqual(extractFirstBold("**hello**"), "hello");
  });

  it("skips leading prose before the first pair", () => {
    assert.strictEqual(extractFirstBold("text **bold** more"), "bold");
  });

  it("returns null when the opening pair is unclosed", () => {
    assert.strictEqual(extractFirstBold("**open only"), null);
  });

  it("returns null when the bold body is only whitespace", () => {
    assert.strictEqual(extractFirstBold("** **"), null);
  });

  it("returns null on an empty string", () => {
    assert.strictEqual(extractFirstBold(""), null);
  });

  it("returns null when there is no bold at all", () => {
    assert.strictEqual(extractFirstBold("plain text"), null);
  });

  it("trims surrounding whitespace from the bold body", () => {
    assert.strictEqual(extractFirstBold("**  spaced  **"), "spaced");
  });
});

describe("createReasoningStatusBuffer", () => {
  it("emits a status tag once the first complete bold is seen", () => {
    const out: string[] = [];
    const buf = createReasoningStatusBuffer((s) => out.push(s));
    buf.append("**Reviewing test**");
    assert.deepStrictEqual(out, [`${STATUS_TAG_OPEN}Reviewing test${STATUS_TAG_CLOSE}`]);
  });

  it("does not emit until the first bold pair is complete", () => {
    const out: string[] = [];
    const buf = createReasoningStatusBuffer((s) => out.push(s));
    buf.append("**Reviewing");
    assert.deepStrictEqual(out, []);
    buf.append(" test**");
    assert.deepStrictEqual(out, [`${STATUS_TAG_OPEN}Reviewing test${STATUS_TAG_CLOSE}`]);
  });

  it("dedupes repeated emissions of the same header", () => {
    const out: string[] = [];
    const buf = createReasoningStatusBuffer((s) => out.push(s));
    buf.append("**Same**");
    buf.append("**Same**");
    assert.strictEqual(out.length, 1);
  });

  it("emits a new tag after reset() picks up a different header", () => {
    const out: string[] = [];
    const buf = createReasoningStatusBuffer((s) => out.push(s));
    buf.append("**First**");
    buf.reset();
    buf.append("**Second**");
    assert.strictEqual(out.length, 2);
    assert.ok(out[0].includes("First"));
    assert.ok(out[1].includes("Second"));
  });

  it("reset() clears the buffer so the next header can be emitted again", () => {
    const out: string[] = [];
    const buf = createReasoningStatusBuffer((s) => out.push(s));
    buf.append("**One**");
    buf.reset();
    buf.append("**One**");
    assert.strictEqual(out.length, 2);
  });
});

describe("emitStatus", () => {
  it("wraps text in a status tag and forwards to onOutput", () => {
    const calls: string[] = [];
    emitStatus((s) => calls.push(s), "Working");
    assert.deepStrictEqual(calls, [`${STATUS_TAG_OPEN}Working${STATUS_TAG_CLOSE}`]);
  });
});
