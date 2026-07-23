# Multi-repository task manual management

Adds the human-facing management layer for active multi-repository tasks.

- Exposes task create, update, and repository-approval commands through the shared client runtime.
- Adds a task management dialog to user-created task threads.
- Lets users approve additional repositories without eagerly creating worktrees.
- Lets users create additional task-root coordination threads as local drafts.
- Distinguishes first-task drafts from additional-thread drafts so first send creates only the
  missing durable entities.
- Refreshes generated `TASK.md` context after repository approval.

Agent-created task threads remain read-only and do not expose the management entry point.
