# Multi-repository task persistence

- Added a task projection table that persists stable task roots, internal workspace projects,
  approved repository ids, lifecycle status, and completion timestamps.
- Added project visibility and thread task-lineage columns with backward-compatible defaults for
  existing standalone projects and threads.
- Added focused task projection repository and migration coverage.
