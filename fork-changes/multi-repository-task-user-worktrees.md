# Multi-repository task user worktrees

Adds manual repository-bound user threads to active tasks.

- Approved repositories expose a dedicated new-thread action in task management.
- Repository-bound task threads begin as local drafts with explicit branch selection.
- First send creates the durable user thread and delegates worktree creation to the existing
  task-aware bootstrap path.
- Each thread receives its own managed worktree beneath the task root.
- Task-root coordination drafts continue to use the internal non-Git workspace.
