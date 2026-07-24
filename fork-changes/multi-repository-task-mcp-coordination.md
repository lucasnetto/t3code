# Multi-repository task MCP coordination

User-created task threads can now coordinate durable work through three
provider-neutral MCP tools:

- spawn an agent-created task thread with an exact caller-supplied message;
- send a follow-up message to an idle agent-created thread;
- wait for a bounded interval and inspect selected thread statuses.

Spawning without a repository targets the task workspace. Supplying an
approved project creates a unique branch and task-owned worktree, launches the
existing setup script without waiting for its exit, and then starts the first
provider turn. Failures compensate by removing any newly created worktree and
thread without forcing dirty checkout deletion.

Every operation rechecks the active task, caller lineage, target membership,
and repository approval. Mutating operations additionally require the calling
thread's projected provider session to be running with a non-null active turn
at invocation time, so a credential cannot keep changing task state after its
provider turn has stopped. Agent-created threads do not receive the MCP
capability needed to invoke these tools recursively.

Spawning a repository thread revalidates that mutation scope after worktree
creation and immediately before dispatching `thread.agent.create`. If the active
caller turn changed during worktree creation, spawning stops and compensates by
removing the new worktree without persisting a child thread. The create command
still carries the original invocation turn as its expected lineage; the
authoritative orchestration decider must independently require that exact turn
to remain the active running turn when it serializes the command.

Repository spawn bases are limited to existing local or remote branch names.
`HEAD` (including the default when `baseRef` is omitted) resolves to the current
named local branch before worktree creation. Option-like values and revision
expressions are rejected, the resolved stable branch name is used for both
checkout creation and base metadata, and the Git adapter separates worktree
operands from options with `--`.

This is not a general lock or credential redesign. The pre-dispatch check avoids
expensive leaked-worktree races, while the decider remains the final authority
for changes between the refreshed projection and serialized dispatch.

Every `thread.turn.start` targeting a task-aware thread also passes through one
serialized decider invariant, whether it came from `task_send_message`, the
initial turn of `task_spawn_thread`, or a generic client command. At the command
queue position where the start is decided, the task must still be active; the
thread must be live, unarchived, and not explicitly settled; and its projected
session must be neither starting nor running and must have no active turn. The
same restrictions intentionally do not change standalone thread behavior.

This relies on the command read model as the authority for ordering: session and
task lifecycle commands accepted earlier in the orchestration queue are visible
to the turn-start decision. Provider state that has not yet been ingested as an
orchestration command has no earlier ordering relationship to enforce.

Spawn acquisition now treats worktree creation and `thread.agent.create`
dispatch as short uninterruptible commit points. An interrupt cannot arrive
after either operation succeeds but before the handler records responsibility
for compensating it. Setup, turn startup, and projection refresh remain
interruptible.

Failure and interruption compensation runs uninterruptibly and preserves the
original failure or interruption. A created thread is deleted only after its
created worktree has been confirmed removed; if worktree cleanup fails, the
durable thread remains as its visible recovery owner and the server logs manual
recovery guidance.

This is intentionally best-effort v1 recovery rather than a persisted saga. An
abrupt process exit can still occur between an external Git or orchestration
commit and the in-memory ownership record, so startup reconciliation remains
future work.

## Focused test matrix

The coordination toolkit tests cover:

- registration and MCP mutation/read-only annotations for all three tools;
- schema rejection and typed `TaskToolError` responses, including capability
  denial on each handler;
- active caller session and turn fencing, lineage changes during spawn, active
  task checks, task membership, agent-only follow-up targets, and busy targets;
- task-root and repository spawn behavior, approved project validation, stable
  local and paginated remote branch resolution, and unsafe base-ref rejection;
- child-create and initial-turn failures, interruption after each external
  commit point, worktree-first compensation, and retained ownership when
  cleanup fails;
- bounded waits under the test clock, post-wait projection refresh and
  membership revalidation, readable waits after a caller stops, and
  authoritative turn-start race failures;
- decider enforcement for task lifecycle, live and unsettled thread state,
  session/turn idleness, exact spawning lineage, and standalone-thread
  compatibility; and
- Git adapter option separation for worktree creation.
