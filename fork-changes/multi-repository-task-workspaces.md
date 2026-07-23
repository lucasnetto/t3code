# Multi-repository task workspaces

- Added a server task workspace service that derives new task roots beneath the configured
  worktree base while continuing to honor persisted roots for existing tasks.
- Added stable per-thread managed worktree paths beneath each task root.
- Added atomic generation and refresh of `TASK.md` with approved repositories, durable thread
  lineage, and coordination guidance.
