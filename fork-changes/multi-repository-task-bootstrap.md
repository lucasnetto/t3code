# Multi-repository task bootstrap

Task-scoped first-send bootstraps now keep repository worktrees inside the
task's persisted workspace root.

## Behavior

- The server forwards the bootstrap task identifier into the durable thread
  creation command.
- Task workspaces are prepared before repository bootstrap begins and their
  `TASK.md` context is refreshed after structural changes.
- Repository worktrees use a stable path beneath
  `<task-root>/worktrees/<thread>-<repository>`.
- If a later bootstrap step fails, the server attempts to remove the worktree
  created by that bootstrap before deleting the newly created thread. Cleanup
  is intentionally non-forcing so a dirty worktree is not destroyed.
- Threads outside a task retain the existing worktree allocation behavior.

## Verification

- Focused server type checking.
- The complete focused websocket bootstrap test group, including task-owned
  paths and post-creation compensation.
