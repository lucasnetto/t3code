# Multi-repository task aggregate

- Extended orchestration commands, events, aggregate receipts, the in-memory projector, and SQL
  projections with the task aggregate.
- Made `task.create` atomically create the durable task and its hidden non-repository workspace
  project. The server owns this internal command and the task-root source of truth; paired clients
  cannot dispatch raw task creation payloads.
- Added explicit repository approval and task-title update commands with active-task and
  visible-project invariants.
- Added task-aware user thread creation and an internal agent-thread creation command. User threads
  record `createdBy.kind = "user"` while agent threads persist the spawning thread and turn. Agent
  lineage is accepted only from a live, unarchived, unsettled user-created task thread and its
  currently running projected turn/session; agent-created threads cannot recursively become
  parents.
- Kept the provider handler responsible for deriving lineage from the executing turn and checking
  that session immediately before dispatch. The decider validates the persisted snapshot but cannot
  by itself close the handler-to-dispatch race.
- Rejected task threads outside the approved repository set and ordinary project mutation against
  task-owned workspace projects.
- Required approved repositories to remain active visible projects when a task is created, when
  they are added to an existing task, or when they are used for task-aware user/agent thread
  creation. Soft-deleted repositories are rejected without changing the legacy standalone-thread
  behavior.
- Preserved standalone project and thread behavior when task context is absent.
