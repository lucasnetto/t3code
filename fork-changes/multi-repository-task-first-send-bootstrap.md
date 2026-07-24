# Multi-repository task first-send bootstrap

Task drafts can now be promoted through the existing first-turn bootstrap
boundary without accepting a client-selected task root.

The bootstrap request identifies the task, its hidden workspace project, the
initial approved repositories, and the first user-created thread. The server
resolves the task root from its configured worktree base and dispatches one
`task.create` command that atomically records the hidden project, task, and
initial user thread before preparing `TASK.md` and starting provider execution.

If later filesystem preparation or turn startup fails, the durable task and
first thread remain available for recovery instead of leaving an ungrouped
thread or silently deleting the task's coordination history. Retrying that
same first-send request resumes bootstrap when the persisted active task,
internal workspace project, and pristine user-created task-root thread exactly
match the original request. Partial state or reused identifiers with different
metadata are rejected as collisions; v1 intentionally does not add a
persistent bootstrap saga or process-crash reconciler.

The dispatch boundary also validates bootstrap field combinations before any
task, thread, worktree, setup-script, or turn-start side effect. A task
bootstrap must include its matching task-root thread and cannot prepare a
repository worktree. Worktree preparation must include a repository-bound
thread whose project, source checkout, task approval, and base branch match,
and a setup script can run only for a worktree prepared by that same request.
Ordinary turn starts and standalone local-thread bootstrap remain compatible.
