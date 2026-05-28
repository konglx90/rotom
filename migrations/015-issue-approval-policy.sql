-- Per-issue approval policy for tool calls.
--   r_allow  (default) → writes go through human approval, reads pass
--   rw_allow           → bypass: claude --permission-mode bypassPermissions w/o
--                        PreToolUse hook; codex executor without
--                        onApprovalRequest callback (auto-accepts).
-- Reads (Read/Grep/Glob, codex equivalents) are always allowed.

ALTER TABLE issues ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'r_allow';
