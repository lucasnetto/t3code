# Multi-repository task pull request tool

Extends the task coordination toolkit with a selected-thread pull request action.

- `task_create_pull_request` authorizes a same-task repository thread, reuses the existing
  push/PR workflow, and returns the discovered or newly created pull request.
- Task-root threads and threads outside the caller's task return typed unavailable errors.
- Pull request creation snapshots the active task, repository checkout, branch, turn, and provider
  session identity. The snapshot is revalidated immediately before the first push or pull-request
  mutation; a changed or newly busy target returns a typed conflict without starting remote work.
- The race guard is optimistic and lock-free. Coordinators retain normal permission-governed access
  to task worktrees.
- The tool remains capability-gated to user-created threads in an active task.
- V1 adds no task-level cross-thread or task-root conversation-only revert surface. Existing
  ordinary repository-thread checkpoint revert remains unchanged and is not exposed through the
  task toolkit.
