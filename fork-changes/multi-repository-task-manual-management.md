# Multi-repository task manual management

Adds the human-facing management layer for active multi-repository tasks.

- Exposes task create, update, and repository-approval commands through the shared client runtime.
- Adds a task management dialog to user-created task threads.
- Lets users approve additional repositories without eagerly creating worktrees.
- Validates new approvals against the active project projection and the server's Git workflow before
  committing them. Missing, deleted, task-internal, and non-Git projects are rejected with actionable
  errors; existing approvals and receipt-deduplicated retries remain readable. The management dialog
  hides internal candidates and disables projects already known by the client to be non-repositories,
  while the server remains authoritative for unknown or stale client state.
- Lets users create additional task-root coordination threads as local drafts.
- Surfaces pending, success, and failure state for task-title updates, repository approvals, and
  additional coordination-thread creation. Failed mutations keep the dialog and title draft intact,
  and a task mutation is only presented as successful after its command acknowledges success.
- Distinguishes first-task drafts from additional-thread drafts so first send creates only the
  missing durable entities.
- Refreshes generated `TASK.md` context after repository approval. The durable approval remains a
  successful RPC result if this derived-file refresh fails; the server logs the failure with the task,
  project, and command identifiers, and retrying the receipt-deduplicated command safely retries
  materialization.

Agent-created task threads remain read-only and do not expose the management entry point.
