# Multi-repository task aggregate

- Extended orchestration commands, events, aggregate receipts, the in-memory projector, and SQL
  projections with the task aggregate.
- Made `task.create` atomically create the durable task and its hidden non-repository workspace
  project.
- Added explicit repository approval and task-title update commands with active-task and
  visible-project invariants.
- Added task-aware user thread creation and an internal agent-thread creation command. User threads
  record `createdBy.kind = "user"` while agent threads persist the spawning thread and turn.
- Rejected task threads outside the approved repository set and ordinary project mutation against
  task-owned workspace projects.
- Preserved standalone project and thread behavior when task context is absent.
