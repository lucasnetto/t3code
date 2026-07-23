# Multi-repository task client foundations

Task-aware servers now advertise the `taskThreads` execution-environment
capability. Client state consumes the task shell projection and exposes scoped
task atoms and hooks for task-aware interfaces.

The ordinary project collection filters projects marked `internal-task`.
These projects continue to exist in the shell snapshot so task threads can
resolve their workspace, but they do not appear as standalone repositories or
accept ordinary project navigation.

Older servers remain compatible because the capability and visibility fields
are optional and default to the existing standalone-thread behavior.
