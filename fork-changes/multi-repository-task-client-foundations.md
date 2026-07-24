# Multi-repository task client foundations

Task-aware servers now advertise the `taskThreads` execution-environment
capability. Client state consumes the task shell projection and exposes scoped
task atoms and hooks for task-aware interfaces.

The ordinary project collection filters projects marked `internal-task`.
These projects continue to exist in the shell snapshot so task threads can
resolve their workspace, but they do not appear as standalone repositories or
accept ordinary project navigation.

Thread- and task-derived workspace consumers use a separate internal-inclusive
project index. This keeps hidden task roots available to terminals, files, and
other contextual workspace features without exposing them through ordinary
project collections, selectors, or navigation.

Web and mobile archive views apply the same ordinary-project visibility
predicate. Archived task threads remain available under a task-labelled group,
while the internal task workspace name and path are not presented as an
ordinary repository.

Older servers remain compatible because the capability and visibility fields
are optional and default to the existing standalone-thread behavior.
