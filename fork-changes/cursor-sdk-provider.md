# Cursor SDK Provider

Added on 2026-07-14.

## Summary

T3 Code now ships a distinct, built-in `cursorSdk` provider backed by `@cursor/sdk` 1.0.23. It is
separate from the existing Cursor ACP provider, so users can configure and run either integration
without changing the other's behavior.

The provider is disabled by default and authenticates with `CURSOR_API_KEY` from the provider
instance's sensitive environment. Provider status checks discover the authenticated account and
model catalog while retaining the last known catalog through transient probe failures.

## Runtime behavior

- Local agents use a durable SQLite SDK store under the T3 Code state directory.
- Sessions support new-agent creation and versioned resume cursors containing the Cursor agent and
  latest run identifiers.
- Sends are serialized per session; interruption is remembered even if requested before the SDK
  returns a run handle.
- SDK deltas are drained through one bounded, backpressured queue and mapped to canonical assistant,
  reasoning, tool, plan, and token-usage events.
- Shell output is associated only when the SDK supplies an explicit tool call identifier.
- Session creation is an observable, cancellable state. Session stop cancels active work, waits for
  bounded settlement, forcibly terminalizes stuck turns before session exit, and bounds agent/store
  disposal. Adapter teardown stops agents before closing their shared durable store.
- SDK errors are reduced to bounded, redacted metadata before crossing the provider boundary. Native
  diagnostics record only structural event information through the shared provider logger.
- Cursor SDK conversations back T3 Code's thread-history read path when the run exposes that
  capability.
- Commit messages, pull-request content, branch names, and thread titles use short-lived SDK agents
  with the existing shared prompts and sanitizers.

## User experience

Cursor SDK appears as its own early-access provider in settings and session creation, reusing the
Cursor icon and slash-style skill invocation. Its models and parameter variants are populated from
the SDK catalog, with `auto` as the interactive default and `composer-2` as the git-text default.

Draft threads remain on their optimistic timeline until the synchronized server detail contains the
persisted user message. This prevents Cursor SDK's early session lifecycle events from promoting the
route before the first message is available and making that message flash or disappear.

The provider currently advertises only `full-access`. The composer filters unsupported runtime
modes and normalizes stale persisted selections when switching to a Cursor SDK instance. Providers
that do not publish runtime-mode metadata retain the existing three-mode behavior.

## Current limitations

- SDK auto-review remains explicitly disabled pending a separate product and event-mapping design.
- Durable conversation rollback is not exposed by the SDK integration.
- Interactive approval replies are unavailable because this provider operates only in full-access
  mode.

## Validation

- Focused contract, provider, model, mapper, adapter, text-generation, registry, and web tests pass,
  including regression coverage for the first-message draft promotion handoff.
- `vp check` passes. Its nine reported warnings are pre-existing warnings in unrelated web files.
- `vp run typecheck` passes.
- A real-account smoke test was not run because it is opt-in and requires a user-provided
  `CURSOR_API_KEY`.
