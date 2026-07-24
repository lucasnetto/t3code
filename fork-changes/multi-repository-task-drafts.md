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
the task workspace exists. The temporary anchor remains available only to the
first-send bootstrap: task drafts do not bind it to Git status, filesystem or
preview panels, terminal sessions, panel state, project shortcuts, Markdown
path resolution, or editor actions. Existing panel and terminal state is
treated as closed while the route is a task draft, while ordinary thread drafts
retain their current repository UI.

Internal task projects remain absent from ordinary project collections and
selectors, but direct project lookup retains them so task-root threads can
resolve their effective cwd after promotion.

The New task dialog initializes its title and default repository once for each
open/create intent. Repository discovery updates reconcile unavailable entries
and can supply the initial default after an asynchronous load without clearing
the title or replacing repository choices the user has already edited. Closing
the dialog resets that form state before the next open.

Task creation considers only visible Git-backed projects in task-capable
execution environments. The primary environment is the default only when it
has an eligible repository; otherwise the first eligible environment is
selected deterministically. An explicit environment choice remains stable for
the lifetime of the open dialog. When no environment has an eligible
repository, the dialog shows an empty-state explanation and keeps creation
disabled.

Persisted task drafts also reconcile their approval allow-list after the
environment snapshot loads. Repositories that were deleted, hidden, or became
ineligible are removed without granting newly discovered repositories; if the
temporary anchor disappeared, the first surviving approved repository becomes
the anchor. Task title, task/workspace identifiers, valid approvals, and
composer content remain intact. First-send refuses stale or empty approval
sets, and an empty set shows guidance to create a new task with currently
available repositories.
