# Multi-repository task bootstrap

Task-scoped first-send bootstraps now keep repository worktrees inside the
task's persisted workspace root.

## Behavior

- The server forwards the bootstrap task identifier into the durable thread
  creation command.
- Task workspaces are prepared before repository bootstrap begins and their
  `TASK.md` context is refreshed after structural changes.
- Repository worktrees use a stable path beneath
  `<task-root>/worktrees/<thread>-<repository>`.
- Task-aware repository bootstrap resolves the source checkout from the active,
  approved project projection. The legacy `projectCwd` bootstrap field is
  accepted for wire compatibility only when its normalized path agrees with
  that projection; it is never an independent task-worktree authority.
- Deleted projects, task-internal workspace projects, and projects outside the
  task's approved repository set are rejected before thread or worktree
  creation.
- If a later bootstrap step fails, the server attempts to remove the worktree
  created by that bootstrap before deleting the newly created thread. Cleanup
  runs for both ordinary failures and interruption, is protected from further
  interruption, preserves the original dispatch error, and remains
  intentionally non-forcing so a dirty worktree is not destroyed.
- Worktree creation itself is exception-safe across its two Git steps. If
  `git worktree add` succeeds but the new branch's Graphite merge-base
  configuration fails, the Git driver removes the exact worktree and the local
  branch created by that operation before returning the configuration error.
  Later bootstrap compensation does the same by carrying the created branch's
  original commit as driver-issued cleanup proof. Branch deletion uses an
  expected-old-value ref update only after confirming the branch still points
  to that commit and is not checked out in another worktree. Pre-existing,
  moved, checked-out, or unverifiable branches are retained with an exact
  diagnostic instead of being deleted. If worktree removal itself fails, the
  typed Git error retains both failures and reports the path that remains
  registered.
- A failed worktree removal retains the created thread and its persisted
  worktree metadata as the durable owner instead of deleting the ownership
  record. The original bootstrap error is still returned, while the cleanup
  failure is logged with the thread, source checkout, and retained worktree
  path for manual recovery.
- Task bootstrap compensation regenerates `TASK.md` from the latest task
  projection after either deleting the compensated thread or retaining it as
  the owner of a worktree that could not be removed. This keeps the generated
  thread inventory aligned with the durable outcome. A context refresh failure
  is logged with the cleanup disposition and recovery guidance without
  replacing the original bootstrap error or triggering any additional
  ownership deletion.
- This is bounded, best-effort compensation rather than a durable bootstrap
  saga. Process-crash orphan reconciliation and resumable bootstrap recovery
  remain deferred to Phase 5 and the existing cleanup behavior. In particular,
  a process exit between structural mutation and compensation can still leave
  `TASK.md` stale until the next successful workspace preparation.
- Threads outside a task retain the existing worktree allocation behavior.

## Verification

- Focused server type checking.
- Focused Git driver coverage injects a branch-configuration failure after a
  successful `worktree add` and verifies that neither the worktree registration
  nor its directory or created branch remains, then retries the same branch
  name. Additional coverage verifies that moved and pre-existing branches are
  retained.
- The complete focused websocket bootstrap test group, including task-owned
  paths, projected repository binding, compatibility-path mismatch rejection,
  standalone bootstrap compatibility, ordinary-failure compensation, and
  interruption compensation. Cleanup-removal failure coverage verifies that
  the owner thread and discoverable worktree metadata are retained while the
  original bootstrap error remains the RPC result.
- Focused task-context compensation coverage verifies successful thread
  deletion removes the thread from `TASK.md`, failed worktree removal keeps the
  retained owner listed, and context-refresh failure preserves the original
  bootstrap RPC error.
