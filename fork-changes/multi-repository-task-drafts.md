# Multi-repository task drafts

Sidebar v2 now offers a capability-gated **New task** flow. A task draft keeps
its title, server-generated task/workspace identifiers, and approved repository
set in the existing persisted composer draft store.

Creating the draft does not write task state to the server or create a
checkout. The first user message promotes it through the task-aware first-send
bootstrap, which creates the hidden workspace project, task, and first
user-created thread before provider execution starts.

The task draft view names the task rather than its temporary repository anchor
and suppresses repository checkout, editor, script, and terminal controls until
the task workspace exists.

Internal task projects remain absent from ordinary project collections and
selectors, but direct project lookup retains them so task-root threads can
resolve their effective cwd after promotion.
