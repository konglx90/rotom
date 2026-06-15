import styles from './StreamingStatus.module.css'

/**
 * Sticky "currently doing X" pill rendered above a streaming message.
 *
 * Populated from `[status:thinking]…[/status:thinking]` tags emitted by the
 * executor. Mirrors codex's `set_status_header` / `status_indicator` widget
 * (codex-rs/tui/src/chatwidget/status_controls.rs:58-65,
 *  codex-rs/tui/src/bottom_pane/status_indicator_widget.rs:109-111).
 *
 * The label is whatever the model said it was working on — a static
 * "Working" emitted at turn start, or a bold heading extracted from the
 * reasoning stream ("**Reviewing the failing test**"). Once the executor
 * emits a fresh status tag, this component receives the new value and the
 * pill updates in place (no new row added to the history).
 *
 * `done` is flipped once streaming stops so the pill stops pulsing and
 * settles into a static terminal state (still visible above the message so
 * the user can see the final state of the last tool call / turn — e.g.
 * "Answered", "Failed", or the last reasoning header).
 *
 * `variant` controls layout: "default" renders as a block pill above the message,
 * "inline" renders inline with zero margin/padding/border for use on the sender line.
 */
export function StreamingStatus({ content, done, variant = 'default' }: { content: string; done?: boolean; variant?: 'default' | 'inline' }) {
  return (
    <div
      className={`${styles.status} ${done ? styles.statusDone : ''} ${variant === 'inline' ? styles.inline : ''}`}
      aria-live="polite"
    >
      <span className={`${styles.dot} ${done ? styles.dotDone : ''} ${variant === 'inline' ? styles.inlineDot : ''}`} />
      <span className={styles.label}>{content}</span>
    </div>
  )
}
