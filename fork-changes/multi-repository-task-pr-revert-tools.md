# Multi-repository task PR and revert tools

Extends the task coordination toolkit with selected-thread source-control and checkpoint actions.

- `task_create_pull_request` authorizes a same-task repository thread, reuses the existing
  push/PR workflow, and returns the discovered or newly created pull request.
- `task_revert_thread` authorizes an idle agent-created repository thread and requests its existing
  checkpoint revert path.
- Task-root threads and threads outside the caller's task return typed unavailable errors.
- Both tools remain capability-gated to user-created threads in an active task.
