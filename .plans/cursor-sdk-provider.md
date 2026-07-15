# Plan: Cursor SDK Provider

## Outcome

Add the Cursor TypeScript SDK as a distinct built-in `cursorSdk` provider. The provider must support
normal T3 Code thread creation, streaming, tools, cancellation, restart/resume, model discovery, and
text generation without weakening the guarantees of the current provider runtime.

The existing `cursor` provider remains ACP-only. Users can configure Cursor and Cursor SDK side by
side, migrate by selecting Cursor SDK for new threads, and return to ACP by selecting Cursor. The two
providers have separate settings, sessions, resume cursors, status, and capability reporting.

## Explicit non-goals

- Do not implement Cursor Auto-review in this milestone.
- Do not map SDK mode to Supervised or Auto-accept edits. The Cursor SDK provider initially supports
  only `full-access`; unsupported runtime modes are hidden in the UI and rejected by the server.
- Do not replace, modify the semantics of, or delete the Cursor ACP provider.
- Do not add an ACP/SDK transport toggle to `CursorSettings`.
- Do not import code from the reference fork or make its unrelated timeline-ordering changes.
- Do not add cloud-agent execution. This milestone uses local SDK agents against the thread `cwd`.

## Design decisions

### Provider identity and credentials

- Register a new open driver kind, `ProviderDriverKind.make("cursorSdk")`, with display name
  `Cursor SDK`, an early-access badge, the standard Cursor icon/accent, and multiple-instance support.
- Add an independent `CursorSdkSettings` schema and default `cursorSdk` provider instance. Keep
  `CursorSettings` and the existing `cursor` instance unchanged.
- Keep SDK settings intentionally small. Read `CURSOR_API_KEY` from the provider instance's merged
  environment. Users can already mark provider environment variables as sensitive, so the key stays
  out of ordinary provider config and redacted settings payloads.
- Present this credential as a Cursor User API Key tied to the user's Cursor account/subscription,
  not as an unrelated model-provider key. SDK status must explain when `CURSOR_API_KEY` is absent
  without marking unrelated network, timeout, or rate-limit failures as authentication failures.
- Give `cursorSdk` its own continuation identity. Threads are not silently transferred between ACP
  and SDK runtimes; migration happens by starting a thread with the desired provider.

### Runtime-mode capability

- Add an optional `supportedRuntimeModes` capability to provider snapshots.
- Cursor ACP advertises all currently supported modes. Cursor SDK advertises only `full-access` in
  this milestone.
- The composer filters its runtime-mode selector using this capability and normalizes a stale draft
  selection to a supported mode when the selected provider instance changes.
- The SDK adapter independently validates the mode at session start so stale clients cannot bypass
  the restriction.

### SDK boundary

- Pin the current supported `@cursor/sdk` release in `apps/server`; do not use the older 1.0.13
  dependency from the reference fork.
- Put SDK-specific code under `apps/server/src/provider/sdk/` and keep the existing provider adapter
  contracts unchanged where possible.
- Define a narrow injectable SDK client interface around agent creation/resume, account/model
  discovery, and one-shot text generation. Tests use fakes rather than loading native SDK runtime
  pieces or making network calls.
- Add a dedicated `CursorSdkDriver`, provider layer, adapter layer, service tag, and text-generation
  implementation. Register them through the existing built-in driver catalog and provider instance
  hydration flow.
- Extract genuinely shared Cursor logic—skill discovery, model normalization/capability conversion,
  presentation helpers, and bounded diagnostics—into shared Cursor modules. Do not make the new
  driver call into the ACP driver's runtime-specific code or duplicate common logic.

### Session ownership and persistence

- One T3 session context owns one SDK agent. Avoid a process-global agent pool.
- Acquire and dispose the agent with an Effect scope. Stop/replacement/server shutdown must cancel an
  active run, await its settlement where bounded, and dispose exactly once.
- Use the SDK's durable local store rather than inventing a second conversation history. Scope its
  state root to T3 Code user data and pass the thread `cwd` on create/resume.
- Persist a versioned, provider-tagged resume cursor containing the SDK `agentId` and latest `runId`
  when available. Reject malformed cursors rather than guessing. The distinct driver binding
  prevents SDK cursors from being routed to the ACP adapter.
- Rehydrate thread history from the SDK conversation/run APIs. If SDK rollback cannot mutate the
  durable conversation safely, return a typed unsupported error; never splice only T3's in-memory
  copy and report success.

### Turn lifecycle and concurrency

- Validate prompt text and load/validate all attachments before emitting `turn.started`.
- Serialize `sendTurn` per session. The SDK permits one active run per agent; simultaneous sends
  become ordered follow-ups instead of racing shared state.
- Keep cancellation out of the long-held send mutex: `interruptTurn` and `stopSession` must be able
  to observe and cancel the active run immediately.
- Use an explicit session state machine for creating, ready, running, stopping, and stopped states.
  Clear active run/turn state in finalizers on every success, error, interruption, and defect path.
- Emit exactly one terminal turn event. Terminalize every started assistant/thinking/tool item before
  the turn terminal event, including cancellation and SDK failures.
- Map SDK `finished`, `cancelled`, and `error` results distinctly and preserve retryable/error-code
  metadata without exposing credentials or raw sensitive payloads.

### Ordered event mapping

- Prefer the SDK's structured `onDelta` surface for assistant text, thinking, typed tool starts and
  completions, shell output, plans/todos, and usage.
- Callbacks enqueue typed updates into a per-run queue. A single drain fiber converts them to
  `ProviderRuntimeEvent`s so callback timing cannot reorder the timeline.
- Track tool items by SDK `callId`; do not associate shell output with a guessed "last tool".
- Keep the mapper pure and separately tested. Unknown delta variants should be logged diagnostically
  and ignored safely rather than crashing the run.
- Native SDK diagnostics go through the existing event logger with bounded/redacted payloads.

### Provider status, models, and text generation

- For SDK instances, probe authentication with `Cursor.me()` and discover models with
  `Cursor.models.list()` under explicit timeouts.
- Convert SDK model parameters and variants into T3's existing model-capability descriptors, sharing
  normalization with the ACP path where the shapes overlap.
- Classify authentication, rate-limit, configuration, network, and timeout errors separately in the
  provider snapshot. A failed refresh retains the last known good model catalog.
- Cursor SDK advertises no CLI update maintenance; the SDK is an application dependency, not a
  user-managed `agent` binary. The existing Cursor provider retains its current CLI maintenance flow.
- Add SDK-backed text generation for provider-internal tasks using a short-lived agent/run with a
  timeout and guaranteed disposal. Do not reuse an interactive thread agent.

## Implementation slices

### 1. Contracts and settings UI

- New `cursorSdk` driver registration, `CursorSdkSettings`, and backward-compatible server settings
  defaults. Existing Cursor settings remain unchanged.
- Provider metadata/picker presentation for a distinct `Cursor SDK` entry, reusing Cursor visual
  assets without conflating provider identities.
- Provider `supportedRuntimeModes` capability and composer filtering/normalization.
- Contract, provider-instance, picker, and composer-control tests.

### 2. SDK foundation

- Add and pin `@cursor/sdk`.
- SDK client boundary, typed error mapping, credential resolution, model conversion, and status
  probe with timeouts.
- Dedicated driver wiring for adapter, provider snapshot, skills, and text generation, plus shared
  Cursor helpers where behavior truly overlaps ACP.
- Unit tests using fake SDK clients.

### 3. Session runtime

- Scoped agent create/resume/dispose.
- Versioned resume cursor and durable-store configuration.
- Per-session state machine, serialized sends, immediate cancellation, and bounded shutdown.
- Runtime tests covering create, resume, replacement, concurrent sends, interrupt, stop, and creation
  cancellation.

### 4. Event and history integration

- Pure structured-delta mapper plus ordered queue/drain.
- Terminal item/turn behavior for success, cancellation, SDK error, mapper error, and attachment
  failure.
- SDK-backed thread reads; explicit unsupported rollback until durable rollback is proven.
- Adapter integration tests asserting exact event ordering and no orphaned running items.

### 5. Verification and documentation

- Add `fork-changes/cursor-sdk-provider.md` describing the fork-specific behavior and limitations.
- Run focused tests while iterating, then `vp check` and `vp run typecheck` as completion gates.
- Perform an opt-in manual smoke test with a real `CURSOR_API_KEY`: model discovery, new thread,
  streaming text/thinking/tools, image attachment, cancellation, restart/resume, and follow-up.
- Confirm a Cursor SDK session refuses Supervised/Auto-accept and that the existing Cursor provider
  continues to provide its ACP behavior independently.

## Acceptance criteria

- Existing Cursor instances continue using ACP without configuration migration or behavior changes.
- Cursor SDK appears as a separate provider and can coexist with one or more Cursor ACP instances.
- A Cursor SDK instance can authenticate, list models, start/resume a local agent, stream a complete
  ordered timeline, execute follow-ups, and cancel reliably.
- SDK session state survives a T3 Code server restart through the SDK's durable store and T3's
  versioned resume cursor.
- No started turn or item remains running after success, error, interruption, session replacement,
  or shutdown.
- Concurrent sends cannot race the agent or cancel the wrong run.
- `CURSOR_API_KEY` is never written to normal provider config, returned unredacted to the client, or
  included in logs/errors.
- The Cursor SDK provider cannot silently claim to honor Supervised or Auto-accept edits.
- `vp check` and `vp run typecheck` pass.

## Follow-up milestone: Auto-review

After the Cursor SDK provider is stable, design Auto-review as a separate approval/reviewer
capability. That milestone will decide its contract and composer UX, pass `local.autoReview`, define
how held calls appear and are resolved, and test classifier/permissions behavior. None of those
semantics are coupled to the SDK migration above.
