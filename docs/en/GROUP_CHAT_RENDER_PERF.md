---
title: Group Chat Render Performance
description: Optimization log for the dashboard group chat view (GroupChatView → GroupChatArea)
---

# Group Chat Render Performance Optimization Log

Records the rendering perf work on the `dashboard/groups/:groupId` page (`GroupChatView` → `GroupChatArea`), potential issues in unfinished items, and criteria for enabling future optimizations on demand.

---

## Done

### P0-1 Streaming setState RAF batching

`packages/dashboard/src/features/groups/useGroupChatWebSocket.ts`

Changed `a2a_stream_chunk`'s `setMessages` from "call directly per token" to `requestAnimationFrame` batching: at most one commit per frame, merging deltas across multiple streamIds. On stream end (`a2a_stream_end`), sync flush to avoid losing the last segment.

Gain: drops 50-80Hz token stream to ≤60Hz setState; main thread no longer saturated.

### P0-2 Scroll throttling + switch to scrollTop

`packages/dashboard/src/features/groups/GroupChatArea.tsx`

The scroll-to-bottom on `messages` change is throttled via RAF; each change cancels the old RAF and re-schedules, ensuring the latest state change always triggers a scroll. Replaced `scrollIntoView({ behavior: 'smooth' })` with `messagesAreaRef.scrollTop = scrollHeight` (at high frequency, smooth repeatedly interrupts the animation, and the 0-height anchor behavior is unstable).

Gain: layout thrashing eliminated; scroll feels responsive.

### P0-3 groupMembers useMemo

`packages/dashboard/src/features/groups/GroupChatArea.tsx`

`groupMembers` is locked with `useMemo([selectedGroup.members])`, preventing each render from creating a new array that would break `MarkdownContent.memo`'s shallow comparison.

### P1-1 Extract MessageRow + memo

`packages/dashboard/src/features/groups/MessageRow.tsx` (new)

Extracted single-message rendering out of `GroupChatArea`, wrapped in `memo`. The parent's `onShowPrompt` is locked with `useCallback`. During streaming, the historical message subtree (outer div / Avatar / Badge / StreamingStatus / MarkdownContent) skips reconciliation entirely.

Gain: when streaming with 128 messages, only the latest one goes through full render; the other 127 are zero-cost.

---

## Not done: P1-2 virtual list

### Trigger conditions (when to consider it)

At the current density of ~17 nodes per message:

| Messages | Est. DOM nodes | Status |
|----------|----------------|--------|
| < 300 | < 5000 | Smooth, no virtualization needed |
| 300-500 | 5000-8500 | Scroll starts to show slight jank |
| 500+ | 8500+ | Visible lag, consider virtualization |

### Trade-offs

- **virtual list breaks Ctrl+F**: browser find-on-page won't search unrendered DOM. Need to provide an in-app search.
- **Streaming new messages + virtualization**: when a new message streams in, the virtual list needs to scroll into view; if the user has scrolled up to read history, the auto-scroll shouldn't fight the user.
- **MarkdownContent measurement**: virtual list needs message heights; MarkdownContent (with code blocks / images / tables) has highly variable heights, needs dynamic measurement + cache.

### Decision

P1-1 already makes 500 messages smooth in practice. Virtualization is deferred until a real scenario exceeds 1000 messages.

---

## Not done: P1-3 message height cache

MarkdownContent heights vary a lot (a code block can be 200px, plain text 24px). Currently the browser does layout every render; if it becomes a bottleneck, cache `{ messageContent → measuredHeight }` keyed by content hash.

Skip for now — current measurements show layout is < 2ms per render even with 200 messages.

---

## Not done: P2 streaming delta diff

Currently on `a2a_stream_chunk`, we update the message's `content` string and let React re-render MarkdownContent. For very long outputs (10000+ tokens), MarkdownContent's full re-parse per chunk becomes the bottleneck.

Possible optimization: MarkdownContent switches to incremental render (only re-parse the new tail). Cost: need to maintain the parser's incremental state, complex to implement.

Defer until single-message output exceeds 5000 tokens.

---

## Performance monitoring

Manual verification: Chrome DevTools Performance tab, recording 30s of streaming with 128 messages in the group.

Key metrics:
- **FPS**: stable 55-60 after optimization (was 8-15 before)
- **Main thread**: 60-80% idle (was 100% saturated before)
- **Layout time**: < 50ms per frame (was 200-400ms before)

No automated performance regression test added — the test infrastructure doesn't yet support streaming WebSocket mocks. To be added when the dashboard gets E2E tests.

---

## Future work

| Priority | Item | Trigger |
|----------|------|---------|
| P1-2 | Virtual list | single group messages > 1000 |
| P1-3 | Message height cache | Layout time > 16ms per frame |
| P2 | Streaming delta diff | single message output > 5000 tokens |
| P3 | Auto perf regression test | E2E test infrastructure ready |
