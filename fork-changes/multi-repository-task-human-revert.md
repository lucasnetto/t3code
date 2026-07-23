# Multi-repository task human checkpoint management

Adds an authenticated human management path for repository-bound agent thread checkpoints.

- Introduces `task.thread.revert`, carrying the active task, initiating user thread, target agent
  thread, and selected checkpoint turn count.
- The task decider verifies both threads belong to the same active task, preserves immutable
  creation origins, rejects working or task-root targets, and emits the existing thread checkpoint
  revert request.
- User-created task threads expose agent checkpoint targets in the task management dialog.
- Agent-created thread views remain read-only and still have no direct revert action.

Conversation-only restore for task-root agent threads remains unavailable until its dedicated
provider-session rollback path is implemented.
