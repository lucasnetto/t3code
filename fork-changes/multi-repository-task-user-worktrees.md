# Multi-repository task user worktrees

Adds manual repository-bound user threads to active tasks.

- Approved repositories expose a dedicated new-thread action in task management.
- Repository-bound task threads always begin in managed-worktree mode with explicit branch
  selection. The task draft UI does not offer **Current checkout**, while ordinary standalone
  drafts retain both workspace modes.
- Draft creation, updates, hydration, and first-send preparation defensively normalize stale task
  repository drafts so persisted local/shared-checkout state cannot bypass managed worktree
  creation.
- Repository task drafts snapshot the task environment's `newWorktreesStartFromOrigin` setting,
  matching ordinary managed-worktree drafts. Missing environment configuration falls back to the
  normal server default, and first send keeps the explicitly selected branch as bootstrap metadata
  while the server resolves its origin commit when requested.
- Repository thread drafts retain the task environment as authoritative metadata. The run-on
  selector is read-only for those drafts, direct environment-change callbacks are ignored, stale
  persisted project/environment mismatches are repaired during hydration, and first send targets
  the task environment. Ordinary standalone and task-root drafts keep their existing environment
  behavior.
- A local first-send failure marker makes repository-thread retries deterministic without adding a
  server-side bootstrap saga. A retry reuses the reserved id only when the durable user thread
  matches the same task and repository; otherwise it rotates only the unaccepted thread id while
  preserving the message, branch selection, task metadata, and managed-worktree mode.
- First send creates the durable user thread and delegates worktree creation to the existing
  task-aware bootstrap path.
- Each thread receives its own managed worktree beneath the task root.
- Task-root coordination drafts continue to use the internal non-Git workspace.
