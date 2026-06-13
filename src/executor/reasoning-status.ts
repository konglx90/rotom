/**
 * Reasoning status helpers — port of codex-rs/tui/src/chatwidget.rs:2017-2043
 * (`extract_first_bold`) and the surrounding `set_status_header` /
 * `restore_reasoning_status_header` pattern from
 * codex-rs/tui/src/chatwidget/streaming.rs:8-17.
 *
 * The model is prompted (implicitly via the dashboard's own prompt
 * composition) to begin each reasoning block with a bold title, e.g.
 *   **Reviewing the failing test**
 * We accumulate the reasoning deltas, extract the first complete `**...**`
 * segment, and emit it as a `[status:thinking]…[/status:thinking]` tag so the
 * dashboard can show a sticky "currently thinking about X" pill at the top of
 * the streaming message while keeping the full reasoning collapsed in a
 * `<details>` block.
 *
 * The hand-scan (no regex) is intentional: it matches codex's exact behavior,
 * including the "first `**` we see is the start; if it never closes, stop
 * looking and wait for more deltas" rule, and avoids backtracking on long
 * inputs.
 */

export const STATUS_TAG_OPEN = "[status:thinking]";
export const STATUS_TAG_CLOSE = "[/status:thinking]";

/**
 * Find the first complete `**…**` pair in `s` and return the trimmed inner
 * text. Returns null when no complete pair has been seen yet (which is the
 * expected outcome when called on a partial delta — call again with more
 * deltas later).
 */
export function extractFirstBold(s: string): string | null {
  const bytes = new TextEncoder().encode(s);
  let i = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] === 0x2a && bytes[i + 1] === 0x2a) {
      // 0x2a = '*'
      const start = i + 2;
      let j = start;
      while (j + 1 < bytes.length) {
        if (bytes[j] === 0x2a && bytes[j + 1] === 0x2a) {
          const inner = s.slice(start, j);
          const trimmed = inner.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        j++;
      }
      return null;
    }
    i++;
  }
  return null;
}

export interface ReasoningStatusBuffer {
  /** Append a chunk of reasoning text; may emit a status tag. */
  append(delta: string): void;
  /** Drop the accumulated reasoning; called at section boundaries
   *  (new agent message, tool call begin, turn end, …). */
  reset(): void;
}

/**
 * State machine that owns the running reasoning buffer and emits a
 * `[status:thinking]…[/status:thinking]` tag every time `extractFirstBold`
 * yields a new header. The downstream `MarkdownContent` parser collapses
 * repeated emissions down to the latest one and shows it as a sticky pill.
 */
export function createReasoningStatusBuffer(
  emit: (statusTag: string) => void,
): ReasoningStatusBuffer {
  let buffer = "";
  let lastEmitted: string | null = null;
  return {
    append(delta) {
      buffer += delta;
      const header = extractFirstBold(buffer);
      if (header && header !== lastEmitted) {
        lastEmitted = header;
        emit(`${STATUS_TAG_OPEN}${header}${STATUS_TAG_CLOSE}`);
      }
    },
    reset() {
      buffer = "";
      lastEmitted = null;
    },
  };
}

/**
 * Imperative setter for non-reasoning status updates ("Working", "Running",
 * "Done", "Failed", etc.). Use this from `item/started`, `step_start`,
 * `lifecycle`, etc. — anywhere the executor wants to overwrite the current
 * status without going through the reasoning buffer.
 */
export function emitStatus(
  onOutput: (chunk: string) => void,
  text: string,
): void {
  onOutput(`${STATUS_TAG_OPEN}${text}${STATUS_TAG_CLOSE}`);
}

