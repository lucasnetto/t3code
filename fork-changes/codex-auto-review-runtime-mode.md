# Codex Auto-review Runtime Mode

Added on 2026-07-15.

## Summary

Codex now advertises the shared `auto-review` runtime mode in T3 Code. Selecting it uses Codex
app-server's native approval reviewer instead of treating the mode as a conservative supervised
fallback.

## Runtime behavior

- Thread start and resume send `approvalsReviewer: "auto_review"` with the `on-request` approval
  policy and workspace-write sandbox.
- Turn start repeats the same reviewer override so later turns remain deterministic.
- Other Codex runtime modes explicitly send `approvalsReviewer: "user"`, preventing a resumed or
  reconfigured thread from retaining an earlier auto-review setting.
- Auto-review lifecycle notifications continue through the existing Codex notification stream; the
  app-server owns the terminal approval decision.

## User experience

The Codex access picker includes Auto-review alongside Supervised, Auto-accept edits, and Full
access. Unsupported modes remain hidden based on each provider's advertised runtime-mode metadata.

## Validation

- Focused Codex session-runtime and provider-registry tests cover reviewer selection and advertised
  modes.
- `vp check`, `vp run typecheck`, `vp run lint:mobile`, and the relevant focused tests pass.
