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
thread or silently deleting the task's coordination history.
