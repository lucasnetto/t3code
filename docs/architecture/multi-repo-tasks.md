# Multi-repository tasks with thread-owned checkouts

Status: proposed implementation plan

## Objective

Add a task-oriented multi-repository workflow while preserving T3 Code's existing thread, provider-session, Git checkpoint, diff, revert, source-control, and pull-request behavior.

The provider remains responsible for reasoning, delegation, prompts, and agent behavior. T3 Code supplies durable task organization, approved repository scope, nested Git worktrees, provider working directories, human interaction policy, and task lifecycle management.

The central design choice is deliberate: **a task groups ordinary T3 threads; it does not introduce another checkout-owning domain object.** Repository-bound threads continue to carry their existing `projectId`, `branch`, and `worktreePath`. T3 does not create a workstream aggregate between a thread and its checkout.

The motivating case is one feature that needs coordinated work across several repositories, sometimes with more than one pull request in the same repository.

## Decisions

1. A **task** is the user-visible organization and lifecycle boundary for coordinated work.
2. Every task owns one stable T3-managed directory.
3. A task has no primary repository and no special orchestrator thread.
4. A task may contain multiple **user-created threads**. They are ordinary durable threads created through the client and remain fully human-interactive.
5. Any user-created thread may coordinate the task through task-scoped tools.
6. An **agent-created thread** is an ordinary durable thread spawned by an agent through a task tool.
7. The spawning agent supplies the agent-created thread's ordinary initial message. T3 does not assign a purpose or synthesize a prompt.
8. Agent-created threads receive ordinary repository/provider tools but not task-scoped orchestration tools. They cannot recursively create durable T3 threads, although provider-native child agents remain available.
9. Agent-created threads are durable and readable by users, but first-party clients hide their human composer, model control, checkout mutation control, and direct revert control. This is a UI policy for trusted paired clients; emergency stop remains available.
10. Thread creation origin is immutable. Agent-created threads are not promoted into user-created threads, and user-created threads are not reclassified as agent-created.
11. Repository selection establishes an approved repository set for the task. It does not eagerly create worktrees.
12. Creating any repository-bound task thread creates a new T3-managed Git worktree beneath the task directory. Task creation UI does not offer the shared current checkout; ordinary standalone threads keep their existing choices.
13. Threads retain their current ownership of conversation, provider session, project, branch, worktree path, checkpoints, diffs, filesystem revert, and source-control actions. Checkout ownership here means durable lifecycle, branch, checkpoint, and cleanup attribution; it is not a filesystem access boundary.
14. Each repository-bound thread owns its own checkout in that lifecycle sense. T3 does not durably bind several threads to one checkout, but a trusted task coordinator or provider-native child agent may inspect or modify that checkout when its selected provider sandbox and approval mode permits it.
15. Pull-request state continues to be discovered from the thread's current checkout and branch. The first version does not add durable PR metadata to tasks or threads.
16. Task completion does not require pushing a branch or creating a PR. Users may explicitly retain local-only work and its checkout.
17. Completing a task settles all of its threads.
18. Project setup retains today's behavior: T3 launches the setup script but does not wait for successful exit before starting the first provider turn.
19. Changing the server worktree base directory affects only new tasks. Existing tasks retain their persisted task and worktree paths; T3 does not automatically move them. (There is no separate user-facing worktree-root setting today; the base directory derives from `T3CODE_HOME`/`--base-dir`. Introducing a dedicated setting is out of scope.)
20. Existing non-task threads remain supported without migration into synthetic tasks.
21. A new task remains a client draft until the first user message is sent. First send durably creates the task and first user-created thread, prepares the task directory, and only then begins provider execution. V1 uses best-effort cleanup and retry around partial bootstrap rather than a persistent saga or process-crash reconciliation protocol; a retry reuses the draft's durable IDs and observes any already-created task/thread instead of creating duplicates.
22. Paired authenticated clients remain trusted operators, matching today's RPC model. Task filesystem checks prevent accidental or stale-path deletion; they are correctness defenses, not a new hostile-client security boundary.
23. The server derives each new task root beneath the configured task-worktree base from the task's generated UUID, encoded as a single safe path segment. Repository-bound cwd resolution normally starts from the approved project record rather than accepting a second client-supplied repository path as an independent source of truth.
24. Task-level cross-thread revert and task-root conversation-only revert are deferred beyond v1. Existing ordinary repository-thread checkpoint revert remains unchanged.
25. `task.spawn_thread` inherits the spawning user thread's current provider session configuration: provider instance, `modelSelection`, `runtimeMode`, and `interactionMode`. V1 exposes no child-provider, model, runtime, or interaction override.

## Conceptual model

```text
Task: Implement feature X
│
├── Approved repositories
│   ├── tubarao
│   └── cisne
│
├── User-created thread: Plan and coordinate
│   ├── cwd: <task-root>
│   ├── human-interactive
│   ├── task tools
│   ├── Agent-created thread: tubarao / auth API
│   │   └── branch + worktree + checkpoints + diff + discovered PR
│   └── Agent-created thread: cisne / client integration
│       └── branch + worktree + checkpoints + diff + discovered PR
│
└── User-created thread: Investigate cleanup
    ├── cwd: <task-root>
    └── Agent-created thread: tubarao / cleanup
        └── branch + worktree + checkpoints + diff + discovered PR
```

The two `tubarao` agent-created threads own the lifecycle of separate checkouts and separate PR candidates, represented by their ordinary thread `worktreePath` values rather than another domain entity. Ownership does not prevent trusted coordinator access.

User-created and agent-created describe how a durable thread entered the task and which human interactions are allowed. They do not describe the provider, model, prompt, kind of work, or checkout isolation policy.

## Proposed domain state

The exact Effect schemas and event names should follow existing orchestration conventions. These TypeScript shapes describe the intended ownership model rather than final wire types.

```ts
type Task = {
  id: TaskId;
  title: string;
  status: "active" | "completing" | "completion-blocked" | "completed";
  rootPath: string;
  workspaceProjectId: ProjectId;
  approvedProjectIds: ReadonlyArray<ProjectId>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type ThreadCreatedBy =
  | {
      kind: "user";
    }
  | {
      kind: "agent";
      threadId: ThreadId;
      turnId: TurnId;
    };

type ThreadTaskContext = {
  taskId: TaskId;
  createdBy: ThreadCreatedBy;
};
```

Task membership and creation origin extend the existing thread model. Repository-bound task threads continue to use the existing thread fields:

```ts
type ExistingThreadCheckoutFields = {
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
};
```

For the smallest compatibility change, `workspaceProjectId` identifies an internal non-repository project whose `workspaceRoot` is the task directory. Task-level threads use that project and therefore retain the existing required `projectId` relationship and cwd resolution. The internal project is an implementation detail and does not appear as an approved repository or ordinary sidebar project.

Non-Git workspace roots already work today: sessions start normally, checkpoint capture silently skips, and Git status reports a non-repository state. Project hiding, however, is new work. Projects currently have only soft-delete visibility (`deletedAt`), and the shell snapshot excludes only deleted projects, so an internal-project mechanism needs a contract-level visibility marker plus filtering in the web and mobile clients. The decider must also reject ordinary project commands (rename, delete, script edit, thread creation outside the task) that target an internal task project.

Repository-bound threads use one of `approvedProjectIds`. Their `worktreePath` is a newly created managed task worktree whose lifecycle, branch, checkpoints, and cleanup are attributed to that thread.

## Core invariants

### Task invariants

- A task may contain multiple user-created threads.
- User-created threads are created only through authenticated client actions.
- Agent-created threads are created only through a task tool invoked from an active thread in the same task.
- Any user-created thread may receive the task orchestration capability.
- All task threads and approved projects belong to one execution environment.
- Repository approval is an authenticated client action and does not create a checkout.
- Additional approved repositories and user-created threads may be appended while the task is active.
- No new thread turns, agent-created threads, or repository approvals may start while the task is completing or completed.
- The task's internal workspace project is owned and hidden by the task lifecycle.
- Completion settles every thread in the task but does not require a remote branch or PR.
- A completed task may retain explicitly accepted local-only checkouts.
- A task retains its persisted `rootPath` when global worktree-root configuration changes.
- A task root is server-derived at creation beneath the configured task-worktree base from a generated UUID task ID represented as one safe path segment.

### Thread invariants

- Every thread still maps to one provider conversation/session.
- Creation origin is immutable and determines direct human interaction policy.
- User-created threads expose the normal composer, model controls, history, and revert behavior appropriate to their cwd.
- First-party clients expose an agent-created thread's complete history and status but hide its human composer, model changes, checkout mutation controls, and direct revert controls. Trusted direct RPC or manual intervention is not a v1 authorization concern.
- Agent-created threads receive repository/provider tools but never task-scoped orchestration tools.
- Users may stop an active agent-created thread as an emergency safety action.
- The initial message of an agent-created thread is the ordinary message supplied by its spawning agent.
- An agent-created thread starts with the spawning user thread's current provider instance, `modelSelection`, `runtimeMode`, and `interactionMode`; spawn input cannot override them.
- T3 does not persist or infer a thread purpose such as implementation, review, or research.
- A repository-bound thread continues to own its current thread-scoped checkpoints, diffs, Git actions, and combined conversation/filesystem revert.
- A task-root thread has a non-Git cwd and has no task-specific revert path in v1.
- Existing standalone threads retain their current behavior when task context is absent.

### Checkout invariants

- A newly created task worktree belongs to one approved project and is nested beneath the task directory.
- Every repository-bound thread owns exactly one worktree created for it. Creation flows never durably bind a new thread to an existing thread's checkout.
- Checkout ownership assigns lifecycle, branch, checkpoint, diff, PR-discovery, and cleanup responsibility to one durable thread; it does not restrict trusted coordinators or provider-native child agents from directly accessing the checkout.
- Direct checkout access remains governed by the provider's selected sandbox and approval mode (`approval-required`, `auto-accept-edits`, `auto-review`, or `full-access`) rather than a task-specific filesystem firewall, lock, or lease.
- As defense in depth, deleting one thread never removes a worktree while another live thread references the same normalized persisted path, and later task cleanup considers each distinct worktree path once. These checks guard against legacy or manually produced path overlap, not a supported sharing feature.
- Setup-script launch retains existing semantics: launch failure may be recorded, but T3 does not wait for the script to exit successfully before starting the provider turn.
- Arbitrary external worktrees cannot be adopted into task-managed cleanup in the first version.
- V1 bootstrap cleanup uses server-derived task roots, persisted managed paths, and a lexical descendant check before removing a partially created checkout. Stronger canonical and symlink-aware destructive-cleanup validation belongs to the deferred completion/recovery phase.

## One thread per checkout

Durable checkout sharing between threads is out of scope. Each repository-bound thread is a unit of work that would eventually become a PR, with its own worktree and branch. A task coordinator may nevertheless enter a nested checkout to inspect or modify it, and provider-native child agents may operate in their parent thread's checkout. An agent that wants an independently tracked unit of work spawns a separate agent-created thread, which receives its own worktree.

The owning thread remains the single durable attribution point for checkpoints, diffs, revert, branch rename, PR discovery, and cleanup. T3 trusts coordination within the task: if a coordinator directly changes an owned checkout, those changes may appear in the owning thread's next checkpoint or diff without separate writer attribution. The provider sandbox and approval mode are the authority boundary; v1 adds no task-specific filesystem firewall, context root, lock, or lease.

## Filesystem layout

Use a stable T3-managed directory for each task:

```text
<server-worktree-base>/tasks/<task-id>/
├── TASK.md                         generated task context
└── worktrees/
    ├── <thread-id>-tubarao-auth/
    ├── <thread-id>-cisne-client/
    └── <thread-id>-tubarao-cleanup/
```

The server worktree base is today's `{baseDir}/worktrees` directory derived from `T3CODE_HOME`/`--base-dir`. Standalone-thread worktrees currently land in a flat branch-derived layout (`{worktreesDir}/{repo}/{branch-slug}`); task worktrees instead use explicit thread-derived paths beneath the task directory, which `createWorktree` already supports through its explicit-path parameter. The task workspace service, not an RPC path argument, constructs `<server-worktree-base>/tasks/<task-id>` from the generated UUID task ID encoded as a single safe segment.

Each directory under `worktrees/` is a real Git worktree created for and lifecycle-owned by one repository-bound thread. The database is the source of truth for task membership and managed paths; directory enumeration is not.

Persist normalized absolute paths and compare checkout identity through a cross-platform normalization helper. During v1 bootstrap compensation, remove only a path produced by the task workspace service and lexically contained beneath the persisted task root's `worktrees/` directory; retain and report anything that fails that check. Canonical identity, symlink-aware containment, and legacy-path hardening are deferred with the broader destructive completion/recovery machinery. These are cleanup-correctness safeguards, not a hostile-client boundary. The main checkout, T3-managed task worktrees, and external worktrees remain distinct workspace kinds even if their display labels match.

The server worktree base is consulted only when creating a task. Each task persists the resulting normalized absolute `rootPath`, and its managed worktree paths remain anchored there. Cleanup validates against that persisted root rather than recomputing it from the current global configuration. Changing the base directory does not move existing task directories or rewrite thread paths. Reactivating an existing task continues using its persisted location; if that location is unavailable, T3 reports an actionable error rather than silently relocating it. Explicit task relocation is deferred.

`TASK.md` is generated context, not durable domain state. It may summarize the task, approved repositories, threads, branches, currently discovered PRs, creation lineage, and available orchestration tools. It should be refreshed atomically when task structure changes.

This layout gives every provider a normal cwd:

- Task-level user-created thread: the task root through the internal task workspace project.
- Task-level agent-created thread: the task root through the internal task workspace project.
- Repository-bound user-created thread: its managed `worktreePath`.
- Repository-bound agent-created thread: its managed `worktreePath`.

A task-level thread can see nested worktree directories and may explicitly `cd` into them to inspect or modify repository state. Its selected provider sandbox and approval mode govern that access exactly as they do elsewhere. Because its provider-session cwd is the non-Git task root, its own thread checkpoints do not capture nested repository changes; direct changes are instead visible through the repository-bound owning thread's checkout and may be included in that thread's later checkpoints without separate writer attribution.

Repository-bound threads retain provider-native repository skill and instruction discovery. Task-level threads receive generated task context and coordinate primarily through T3 task tools.

## Provider boundary

T3 should not recreate provider reasoning, prompt design, review behavior, or native subagent implementations.

### User-created threads

User-created threads use the same provider-session and turn lifecycle as standalone threads. Their effective cwd comes from their existing project/worktree fields:

- Task root for threads using the internal task workspace project.
- Repository worktree for repository-bound threads.

Task-level user-created threads receive generated task context and task-scoped orchestration tools. The model decides whether to delegate, what message to give a child thread, and how to use its result.

### Agent-created threads

`task.spawn_thread` creates an ordinary durable provider thread and records the spawning thread and turn. It uses the exact initial message supplied by the spawning agent. T3 does not prepend a review template, assign a purpose, or maintain a separate worker runtime.

At invocation time, the server snapshots the spawning user thread's active provider session configuration and uses that same provider instance, `modelSelection`, `runtimeMode`, and `interactionMode` to start the child. These are not `task.spawn_thread` arguments. If the inherited provider instance, model, or active session is unavailable, spawning fails through the existing provider/session-unavailable error path; T3 does not silently select a default provider, model, or permission mode.

An agent-created thread may:

- Run at the task root.
- Create a new worktree for an approved repository.

Agent-created threads do not receive task-orchestration capabilities and cannot recursively create durable T3 threads. They receive the ordinary repository/provider tools appropriate to their cwd and may still use provider-native child agents.

Human read-only behavior is a first-party client presentation policy: the UI hides the composer and direct mutation controls for agent-created threads. V1 does not add server authorization checks for trusted paired clients and does not make the provider's filesystem read-only. Emergency stop and same-task management actions remain visible UI exceptions.

### Provider-native child agents

Providers may still use native child agents inside any T3 thread. Those children remain provider-internal activity and are distinct from durable T3 agent-created threads.

Provider adapters may project native child identity, status, usage, and results into an agents panel or nested activity. Native children do not automatically become task threads or independently addressable T3 conversations.

Native children and provider-initiated background work may still block task cleanup while active even though they are not durable task entities.

## Task orchestration tools

Deliver manual task, repository approval, and user-thread management before agent-controlled orchestration. Then expose agent-thread creation and coordination through the local T3 MCP server or equivalent provider-neutral tool surface.

Initial tool candidates:

```text
task.list_repositories()
task.list_threads()
task.spawn_thread(message, project_id?, base_ref?)
task.send_message(thread_id, message)
task.wait_for_threads(thread_ids)
task.get_thread_status(thread_id)
task.read_thread(thread_id, cursor?, max_chars?)
task.get_thread_diff(thread_id, from_turn?, to_turn?)
task.create_pull_request(thread_id)
```

`project_id` selects the new thread's cwd:

- Omitted means task-root cwd.
- Present creates a managed worktree for an approved repository, owned by the new thread.

When `project_id` is present, the server verifies task approval and resolves the repository source cwd from that project's projection. Bootstrap should not treat a client/provider-supplied cwd as a second authoritative repository location; if an existing compatibility path still carries one, it must agree with the resolved project before use.

`task.spawn_thread` always creates an agent-created thread. The authenticated client thread-creation command always creates a user-created thread. Neither entry point accepts a purpose.

The spawning agent's `message` becomes the new thread's ordinary initial message. Subsequent messages sent through `task.send_message` are agent-originated coordination messages, not human client messages.

The tool contract intentionally has no provider instance, `modelSelection`, `runtimeMode`, or `interactionMode` parameters. The server copies those effective values from the active caller session into ordinary thread/session bootstrap. Cross-provider delegation and child-specific model or permission overrides are deferred beyond v1.

Tools are scoped to the current task. A provider cannot name arbitrary tasks, projects, paths, or threads outside that scope. Creating a new repository checkout requires an approved project.

`task.send_message` targets an agent-created thread in the current task. User-created threads continue to receive human messages through their own client composer.

`task.wait_for_threads` is a bounded wait, not an unbounded block. It returns after a server-defined maximum interval with the current status of each requested thread, and the agent re-invokes it to continue waiting. Provider CLIs impose tool-call timeouts that make indefinite blocking unreliable, and a permanently blocked parent turn would itself count as active work during task-completion quiescence.

`task.read_thread` returns bounded, paginated transcript data. It accepts only a thread in the current task, applies a server-defined response cap even when `max_chars` is larger, and returns an opaque cursor for the next page.

`task.get_thread_diff` and `task.create_pull_request` require a repository-bound target with an available Git cwd and otherwise return a typed unavailable error.

Task tools build on the existing local MCP surface: T3 already runs an HTTP MCP server at `/mcp` with per-thread bearer credentials and a per-credential capability set, injected into the Codex, Claude, Cursor ACP, OpenCode, and Grok adapters. That surface currently defines a single hardcoded `preview` capability and one global toolkit, so task tools require a new task capability value, per-credential capability sets issued at session preparation, and capability-gated tool visibility or invocation. The Cursor SDK adapter has no MCP injection today; it either gains one or its sessions are excluded from task tools in the first version.

Clients and servers additionally negotiate a `taskThreads` entry on the existing `ExecutionEnvironmentCapabilities` advertisement (the same skew-gating pattern as `threadSettlement`) so older client/server pairs continue using standalone-thread behavior.

Only user-created task threads receive the task-tool capability. Creation origin therefore determines task-tool availability at provider-session startup.

## Delegation workflow

### New repository checkout

1. An agent running in a task thread decides that another durable thread should perform repository work.
2. The agent chooses one of the task's approved repositories.
3. The agent calls `task.spawn_thread` with `project_id`, an optional base ref, and the child message; it cannot request a different provider, model, runtime, or interaction mode.
4. T3 snapshots the active caller session's provider instance, `modelSelection`, `runtimeMode`, and `interactionMode`, creates an ordinary agent-created thread, and uses the existing thread bootstrap to create a worktree beneath the task directory.
5. T3 launches the project setup script using today's non-blocking behavior. A successful launch does not wait for successful script exit, and a launch failure is recorded without preventing the provider turn.
6. T3 records the spawning thread and turn, resolves the new worktree cwd, and starts the ordinary provider turn with the inherited session configuration. If that provider session, instance, or model is unavailable, the operation returns the existing unavailable error instead of choosing defaults.
7. Users may open and inspect the child thread; first-party clients hide its composer and direct controls.
8. The spawning agent waits for status, reads the result or transcript, and decides what to do next.
9. Existing checkpoint capture, diff, Git, and PR behavior continues to use the child thread's cwd. V1 adds no task-level revert action for that thread.

A review is not a distinct domain workflow. Review and assistance within a unit of work may happen through provider-native child agents inside the owning thread or through a trusted coordinator directly accessing the checkout under its selected provider permissions. T3 does not interpret review requests, create a review entity, or enforce review-specific filesystem behavior.

## Revert behavior

V1 does not add a task-level revert API or UI.

Repository-bound user-created threads retain today's ordinary thread checkpoint revert unchanged. That existing behavior restores the thread's Git checkpoint and rolls back its provider conversation, but those filesystem and provider operations are not atomic.

Task-root threads have a non-Git cwd, so today's checkpoint-based revert does not apply. V1 does not add a conversation-only replacement. First-party agent-created thread views hide direct human revert controls, and task tools cannot revert another thread.

Task-level cross-thread repository revert and task-root conversation-only revert are deferred together. A robust design must define recoverable behavior when one side of a combined filesystem/conversation rollback succeeds and the other fails, including stopped provider sessions. That requires a persistent recovery operation or a deliberately weaker product contract; neither is needed for the initial multi-repository workflow. Ordinary standalone and repository-bound thread revert behavior is not redesigned as part of this work.

## Pull-request behavior

Keep current source-control behavior:

- Commit, push, and PR creation operate on a selected thread's cwd.
- PR status is discovered by matching the checkout's current branch to source-control status.
- Multiple threads with separate worktrees in one repository can produce separate PRs.
- Source-control status refreshes stale stored branch metadata from the actual checkout before matching a PR.
- Stacked actions continue to use the current Git/source-control implementation rather than a task-specific PR model.
- The task does not persist a separate PR record or check-rollup projection.
- If a worktree is removed, historical PR presentation may be unavailable until its checkout is rematerialized. This is accepted for the first version.

The task UI may offer convenience actions that call the existing source-control operation for one or several selected threads, but the thread cwd remains the source of truth.

## Sidebar and navigation

The primary task presentation distinguishes human-interactive user threads from nested, read-only agent-created threads:

```text
Implement feature X
├── User threads
│   ├── Plan and coordinate
│   │   ├── Agent thread · tubarao / Auth API · PR #123
│   │   └── Agent thread · cisne / Client integration · PR #44
│   └── Investigate cleanup
│       └── Agent thread · tubarao / Cleanup · PR #128
└── Approved repositories
    ├── tubarao
    └── cisne
```

Required interactions:

- Create a task draft, approve repositories, and send the first user-thread message.
- Create additional user-created threads inside an active task.
- Create a repository-bound thread with a new managed worktree.
- Do not offer the standalone-thread "Current checkout" choice for repository-bound task threads.
- Open any agent-created thread from its parent, repository activity, notifications, search, or deep links.
- Inspect complete agent-thread history without exposing a human composer or direct mutation controls.
- Stop an active agent-created thread as an emergency action.
- Show repository, branch, current PR state, and spawning thread/turn lineage.

Agent-created threads are nested under their creator by default.

Existing standalone project threads continue to render in their current hierarchy.

## Diff viewer

Keep the current thread-oriented diff model.

- A selected thread supplies its project, cwd, and checkpoint refs.
- Working-tree and turn diffs continue using the existing thread checkpoint and VCS services.
- Source-control and PR diffs continue using the thread cwd and current branch.
- The task may provide a thread selector, but it does not build a synthetic multi-repository diff.

## Deferred task completion and cleanup

This completion and destructive-cleanup workflow belongs to Phase 5 and is not part of the v1 stack.

Task completion remains a deliberate workflow rather than an extension of `thread.settled`.

1. Transition the task to `completing`, increment its lifecycle generation, and reject new turns, thread creation, and repository approval.
2. Fence lifecycle workers and provider reactors against the new generation.
3. Stop or wait for active provider turns, agent-created threads, provider-native children, background processes T3 can observe, setup operations, and terminals.
4. Settle every user-created and agent-created thread in the task.
5. Collect the canonical worktree paths referenced by task threads, deduplicating defensively even though creation flows never share them.
6. Inspect each distinct checkout once for uncommitted files, untracked files, unpublished commits, and active terminals.
7. Do not require a pushed branch or PR. For each local checkout, let the user choose an explicit disposition:
   - **Remove checkout** when there are no uncommitted or untracked files. Local-only commits and the local branch remain in the repository.
   - **Retain local checkout** to preserve the directory as-is, including uncommitted or untracked work.
   - **Discard local work and remove** only through a separately confirmed destructive action.
8. Remove eligible managed worktrees only after verifying task ownership, strict canonical containment beneath that task's managed `worktrees/` directory, and that no live out-of-scope thread references them. Never delete an unresolved, equal-to-root, or out-of-root checkout candidate.
9. Remove the generated task-root filesystem state only when no retained checkout remains and the deletion target exactly matches the task's persisted canonical root. If that identity check fails, retain the directory and report the cleanup error. Otherwise keep the task directory and its retained local work.
10. Retain task membership, the hidden internal workspace project record, thread history, creation lineage, project, branch, worktree-path metadata, and checkpoint summaries so existing thread references remain valid.
11. Mark the task completed even when the user explicitly chose to retain local work.

Transition to `completion-blocked` only when T3 cannot quiesce the task, a filesystem operation fails, or a checkout still lacks an explicit safe disposition. Local-only work is not itself a blocker. Never silently discard uncommitted, untracked, or unpublished work.

Deleting an individual thread keeps the current defensive shared-worktree reference check: the checkout is removed only when no other live thread references it.

A completed task may later be reopened. Its settled threads remain settled until new activity wakes them. The task root is recreated when it was previously removed. Before starting a new turn for a repository-bound thread whose managed path no longer exists, T3 rematerializes its branch as a worktree. A retained checkout is reused in place.

Because PR metadata is not persisted, PR state is rediscovered after rematerialization.

## Event, operation, and projection direction

Add a task aggregate and extend existing thread commands and events using the current command → event → projection architecture.

Candidate commands and events:

```text
task.create                    task.created
task.update                    task.updated
task.repository.approve        task.repository-approved
task.complete                  task.completion-requested
task.reactivate                task.reactivated
task.mark-completed            task.completed

thread.create                  thread.created
```

Task membership and immutable creation origin are supplied as part of task-aware `thread.create`; they are not attached or reclassified later. Task-aware creation extends the existing bootstrap inputs rather than creating a parallel checkout lifecycle:

- Task-root thread creation uses the internal task workspace project.
- New repository checkout creation uses the existing worktree bootstrap with a task-managed destination.

Filesystem work cannot be atomic with the SQLite event transaction. V1 does not add persistent operation/saga state or process-crash reconciliation. Bootstrap uses best-effort interruption/failure compensation; if worktree removal fails, it preserves the truthful durable thread owner and managed path so a retry or later cleanup can see the remaining checkout. Command receipts continue to deduplicate command decisions. Persistent recovery, failure injection across process crashes, and rematerialization are deferred to Phase 5.

First-turn bootstrap itself lives in the WebSocket dispatch path (`dispatchBootstrapTurnStart` in `apps/server/src/ws.ts`), not in the decider or `ProviderCommandReactor`; task-aware creation extends that path.

Task commands reuse the existing orchestration event store, thread projections, provider-session execution, checkpointing, Git services, and runtime-policy boundaries. IDs remain client-supplied in commands, matching current behavior. Adding the task aggregate is a closed-union edit rather than a plugin registration: `OrchestrationAggregateKind` is currently `"project" | "thread"` with monolithic decider/projector switches and `ProjectId | ThreadId` receipt typing, so the aggregate kind, command/event unions, `commandToAggregateRef`, decider, projector, projection tables, shell snapshots, and receipt typing are all touched together. Do not introduce a second provider execution engine, thread projection, checkout aggregate, or event store.

## Lessons adopted from related upstream pull requests

The task model remains independent of these open pull requests, but their focused implementation work should inform this plan:

- [#2829](https://github.com/pingdotgg/t3code/pull/2829) reinforces using the existing orchestration event store, command receipts, provider-session execution, checkpointing, and runtime policy rather than building a second provider execution engine. Provider-initiated background work must be considered by task cleanup.
- [#3754](https://github.com/pingdotgg/t3code/pull/3754) contributes scoped MCP capabilities, worktree setup sequencing, session resume after cwd changes, and compensation patterns that can extend task-aware thread bootstrap.
- [#3898](https://github.com/pingdotgg/t3code/pull/3898) contributes canonical worktree identity, explicit main-checkout semantics, and useful standalone thread grouping. Task membership remains durable and explicit rather than path-derived.
- [#4207](https://github.com/pingdotgg/t3code/pull/4207) contributes branch synchronization state, pull-request check rollups, and worktree labels. These remain checkout observations reached through the owning threads rather than task-owned PR state.
- [#4220](https://github.com/pingdotgg/t3code/pull/4220) contributes provider-native child-agent observability. Native children remain nested activity inside their owning durable thread.
- [#4010](https://github.com/pingdotgg/t3code/pull/4010) contributes bounded, paginated, authorized transcript reads. The task version narrows authorization to threads in the current task.

These are patterns to reuse or reimplement against the merged codebase, not dependencies on unmerged branches.

## Delivery plan

### Phase 1: Task grouping and backward compatibility

- Add branded `TaskId` contracts.
- Add task schemas, commands, events, projections, and read-model queries.
- Extend the closed orchestration aggregate union (`OrchestrationAggregateKind`, `commandToAggregateRef`, decider, projector, projection tables, shells, receipt typing) with the task kind.
- Add optional task context and immutable user/agent creation-origin contracts to existing threads. Phase 1's legal client creation path records only user origin; it models and decodes agent lineage for the records that Phase 4 will create.
- Support multiple user-created threads in one task.
- Create a hidden non-repository project rooted at the task directory for task-level threads, including the new project-visibility marker in contracts, filtering from web and mobile project and archived-project surfaces, and decider rejection of ordinary project commands against internal task projects.
- Keep existing standalone threads unchanged when task context is absent.
- Advertise a `taskThreads` server capability and gate task commands and UI on negotiated support.
- Add focused reducer, decider, projection, persistence, and migration tests.

Exit criterion: tasks, approved repository membership, and multiple user-created threads can be created and read without changing standalone-thread behavior, and internal task projects remain absent from web and mobile project and archived-project surfaces. Reducers, projections, persistence, and shells can also decode agent-created lineage fixtures, but creating those threads is not a Phase 1 exit requirement.

### Phase 2: Task-aware thread worktrees

- Add a task workspace service that owns stable task-root paths.
- Persist each task's resolved root and apply later worktree-base changes only to new tasks.
- Treat selected repositories as approval only; do not eagerly materialize them.
- Extend the WebSocket bootstrap path (`dispatchBootstrapTurnStart`) to create managed worktrees beneath the task directory.
- Normalize persisted paths, derive repository cwd from the approved project, use lexical containment for v1 bootstrap cleanup, and preserve main-checkout, managed-task-worktree, and external-worktree distinctions.
- Refresh a thread's stored branch metadata from its actual checkout when it is renamed or externally changed.
- Generate and refresh `TASK.md`.
- Make task-root and repository-bound effective cwd resolution work through existing thread fields.
- Preserve current setup semantics: record launch failures but do not wait for successful script exit before starting the provider turn.
- Add best-effort interruption/failure compensation for partial task-root and worktree preparation. Preserve truthful durable ownership when cleanup fails so a retry or later cleanup can recover; defer persistent saga state and process-crash reconciliation to Phase 5.

Exit criterion: repository-bound task threads use ordinary T3 worktrees beneath the task root, including multiple separate checkouts for the same approved repository.

### Phase 3: Task sidebar and human interaction policy

- Render tasks with multiple user-created threads and prepare nested agent-created-thread presentation for records created once Phase 4 lands; Phase 3 adds no agent-thread creation path.
- Add task, repository approval, user-thread, and new-checkout thread creation flows.
- For repository-bound task threads, offer only a new managed worktree; do not expose the standalone-thread "Current checkout" choice.
- Keep agent-created threads readable and deep-linkable without a composer, model controls, checkout controls, or direct revert controls.
- Show spawning lineage, repository, branch, current PR, and emergency stop.
- Preserve the existing standalone project/thread UI.

Exit criterion: users can coordinate from any user-created task thread and inspect agent-created threads without introducing a special orchestrator, checkout entity, or new revert workflow.

### Phase 4: Provider-neutral task tools

- Expose task-scoped tools as a new toolkit on the existing local MCP server.
- Extend the MCP capability model: add a task capability alongside `preview`, issue per-credential capability sets at session preparation, and gate toolkit visibility or invocation on the credential's capabilities.
- Add MCP injection to the Cursor SDK adapter or explicitly exclude SDK sessions from task tools in the first version.
- Grant task tools to user-created task threads.
- Explicitly withhold task tools from agent-created threads while preserving their ordinary repository/provider tools and provider-native subagents.
- Implement `task.spawn_thread` as the first legal runtime path for creating an ordinary agent-created durable thread, using the exact caller-supplied initial message and the existing thread bootstrap rather than an earlier internal spawn service.
- Inherit the active spawning session's provider instance, `modelSelection`, `runtimeMode`, and `interactionMode`; expose no spawn-time provider or runtime override and fail through the existing unavailable path instead of selecting defaults.
- Support task-root and new approved-repository checkout targets.
- Present agent-created thread views as read-only in first-party clients by hiding the composer and
  direct mutation controls. This is a UI policy for trusted paired clients, not a new server-side
  authorization boundary across terminal, filesystem, Git, or orchestration RPCs.
- Support messaging, waiting, status inspection, bounded transcript reads, thread diff inspection, and current PR creation.
- Normalize tool results and errors across providers.
- Keep provider-native subagents inside their owning durable thread.

Exit criterion: agents running in any user-created task thread can coordinate durable threads without T3-defined worker purposes or prompts, and every spawned thread either starts with the caller's exact active provider configuration or fails with the existing unavailable error.

### Deferred Phase 5: Completion, cleanup, and recovery

Phase 5 is beyond the v1 stack. It is where stronger destructive-cleanup containment, persistent recovery state, process-crash reconciliation, and rematerialization belong.

- Implement the active/completing/completion-blocked/completed state machine and reactivation path.
- Add lifecycle generation fencing and task-scoped quiescence checks.
- Stop sessions, agent-created threads, observable native children, setup operations, and terminals before cleanup.
- Settle every task thread during completion.
- Defensively deduplicate canonical worktree paths before safety checks and removal.
- Detect dirty, untracked, and unpublished work.
- Record an explicit remove, retain-local, or discard disposition for every checkout.
- Allow completion without a pushed branch or PR and retain selected local-only checkouts.
- Remove eligible managed worktrees and remove the task root only when no retained checkout remains. This is server-side removal machinery; today's orphan cleanup runs in the web client, so only its shared-path safety policy carries over, not its code.
- Retain thread history and binding metadata and rematerialize missing worktrees before reopened turns.
- Add failure injection and restart recovery tests for partial creation and cleanup.

Exit criterion: completing a task settles its threads and either safely cleans or explicitly retains every checkout without requiring publication, losing recoverable work, removing a checkout still referenced outside the cleanup set, or racing accepted provider work.

## Verification strategy

Use focused tests for each phase rather than the full workspace suite.

Backend coverage:

- Task command invariants and event idempotency.
- Multiple user-created threads coexist in one task.
- Client thread creation always records `createdBy.kind = "user"`.
- Phase 1 reducer, projection, persistence, and shell fixtures decode `createdBy.kind = "agent"` lineage without requiring a runtime command that creates it.
- `task.spawn_thread` always records the spawning thread and turn with `createdBy.kind = "agent"`.
- `task.spawn_thread` copies the active caller session's provider instance, `modelSelection`, `runtimeMode`, and `interactionMode` exactly and accepts no override for those fields.
- Spawn fails through the existing provider/session-unavailable path when the inherited provider instance or model cannot be used; it never falls back to configured defaults.
- User-created task threads receive task tools; agent-created threads do not and cannot recursively spawn durable T3 threads.
- Agent-created origin remains available in server projections so first-party clients can apply their UI policy; backend tests do not assert a new origin-based authorization boundary for trusted paired clients.
- Agent-supplied spawn messages become ordinary initial messages without T3 prompt templates.
- Repository approval does not create a worktree.
- A new repository-bound thread rejects projects outside the approved set.
- New managed worktrees are nested beneath the task root.
- New task roots are derived by the server from generated UUID task IDs encoded as safe path segments; RPC callers do not select their filesystem location.
- Repository checkout bootstrap resolves its source cwd from the approved project record and rejects conflicting compatibility-path input.
- Changing the configured worktree root affects new tasks without moving or rewriting existing task paths.
- Spawning a second thread for the same approved repository always creates a separate worktree.
- Task-tool MCP credentials are issued only to user-created task threads; preview-only credentials cannot invoke task tools.
- The defensive reference check still prevents worktree removal while another live thread references the same normalized persisted path.
- Setup launch retains current non-blocking behavior: the first provider turn does not wait for successful script exit.
- Task-root threads receive the task cwd and do not present Git checkpoints or a task-specific revert action.
- Repository-bound threads retain existing combined conversation/filesystem revert.
- Existing Git status, commit, push, PR creation, and PR discovery operate through the selected thread cwd.
- No separate PR metadata is required for task projection or restart.
- Task-scoped transcript authorization, pagination, and output caps.
- Deferred Phase 5 coverage proves completion settles every task thread.
- Deferred Phase 5 coverage proves local-only branches and explicitly retained dirty checkouts do not require a PR or push before completion.
- Deferred Phase 5 coverage covers generation fencing, distinct-path cleanup or retention, blockers, partial cleanup, persistent restart recovery, and rematerialization.
- Deferred Phase 5 coverage adds canonical and symlink-aware containment for destructive cleanup; v1 bootstrap coverage requires server-derived paths plus lexical containment beneath the persisted task root's `worktrees/` directory.
- Provider adapter tests proving each thread receives its expected cwd and task context.
- Coordinator access to nested checkouts follows the selected provider sandbox and approval mode; task orchestration adds no filesystem firewall, lock, or lease.
- Provider-native child activity remains nested in its owning thread and never creates durable task entities.
- Capability negotiation prevents task commands against servers that do not advertise `taskThreads`.

Client coverage:

- Multiple user-created threads render as human-interactive peers.
- Agent-created threads nest under their creator and remain readable without a composer or direct mutation controls.
- Repository-bound task-thread creation never offers the standalone-thread "Current checkout" choice.
- Spawning lineage, deep linking, and emergency stop.
- Repository approval without eager checkout creation.
- New-checkout thread creation.
- Task-root and agent-created thread views do not present task-specific revert actions.
- Existing thread diff and PR presentation within a task.
- Multiple threads for the same repository and PR.
- Deferred Phase 5 client coverage shows settled threads, retained local checkouts, blockers, and cleanup progress for completed tasks.

Integrated verification:

- Run one representative integrated pass for each client surface whose visible behavior changes in that phase; phases with no mobile-visible change do not require a mobile pass.
- Use `test-t3-app` for affected web behavior and `test-t3-mobile` for affected mobile behavior.
- Phase 1 includes a mobile pass proving internal task projects stay hidden from mobile project and archived-project surfaces.
- Later task/thread flows require their own mobile pass only when those flows are implemented on the mobile surface; v1 does not imply mobile task controls that are not otherwise in scope.
- A focused spawn pass proving the child inherits the active caller session configuration, plus an unavailable-provider/model case proving no default fallback. V1 does not require a separate cross-provider or model matrix.

## Resolved policy choices

- Agent-created threads receive ordinary repository/provider tools but no task tools.
- Task completion permits local-only work and does not require a pushed branch or PR.
- Task completion settles every task thread.
- Project setup keeps today's launch behavior and does not gate the first provider turn on successful script exit.
- Worktree-base changes are prospective: existing tasks stay at their persisted paths, and only new tasks use the new base directory.
- `task.wait_for_threads` is a bounded, re-invocable wait rather than an unbounded block.
- V1 adds no task-level cross-thread or task-root conversation-only revert. Existing ordinary repository-thread checkpoint revert remains unchanged.
- `task.create_pull_request` remains in v1 and delegates to the selected repository-bound thread's existing source-control operation.
- Each repository-bound thread owns its checkout lifecycle, branch, checkpoints, and cleanup. Durable checkout binding is not shared, while trusted coordinators and provider-native child agents may directly access the files under their selected provider permissions.
- Paired clients remain trusted operators. Server-derived task roots, project-derived repository cwd, and lexical v1 bootstrap-cleanup containment are correctness safeguards rather than a hostile-client capability system; stronger canonical destructive cleanup is deferred to Phase 5.
- `task.spawn_thread` inherits the spawning user thread's active provider instance, `modelSelection`, `runtimeMode`, and `interactionMode`. V1 has no cross-provider, model, runtime, or interaction override, and unavailable inherited configuration fails instead of falling back.

## Explicit non-goals for the first version

- A workstream, checkout, PR, review, or worker-purpose aggregate.
- A special orchestrator thread type or provider runtime.
- Cross-provider delegation or spawn-time child overrides for provider instance, model, runtime mode, or interaction mode.
- Assigning thread purposes such as implementation, review, research, or custom.
- T3-authored worker or review prompt templates.
- Promoting agent-created threads into user-created threads or reclassifying user-created threads.
- Recursive durable T3-thread delegation from an agent-created thread.
- Human messaging, model changes, or direct checkout/revert controls inside an agent-created thread view in first-party clients. V1 does not enforce this as a server authorization boundary for trusted paired clients.
- Task-level cross-thread repository revert or task-root conversation-only revert. These are deferred until a recoverable partial-failure contract is designed.
- Eagerly creating a worktree for every approved repository.
- Durable checkout binding between threads, including spawn-time checkout reuse and any shared-lifecycle attribution, warning, or revert semantics. This does not prohibit trusted coordinator access to nested checkouts.
- Persisting task- or thread-owned PR metadata after local checkout cleanup.
- Requiring every completed task checkout to be pushed or represented by a PR.
- Automatically moving existing task roots or managed worktrees after a worktree-base change.
- A new user-facing worktree-root setting.
- One task-wide revert across multiple conversations and repositories.
- Enforcing filesystem read-only behavior based on thread creation origin.
- Persistent bootstrap saga state or process-crash reconciliation before deferred Phase 5.
- Treating provider-native subagents as durable T3 task threads automatically.
- Adopting arbitrary external worktrees into T3-managed task cleanup.
- Treating client-local sidebar folders, worktree labels, or path-derived groups as durable task membership.
- Combining several repositories into one synthetic Git diff or one pull request.
- Inferring task membership from every repository found beneath a broad parent directory.
- Replacing provider-native skills, instructions, tools, or agent reasoning with T3-specific equivalents.

## Relevant current implementation

- [`OrchestrationThread`](../../packages/contracts/src/orchestration.ts) already requires `projectId` and stores `branch` and `worktreePath` directly on the conversation. The projection table has no uniqueness constraint on `worktree_path`; one durable lifecycle owner per checkout is enforced by creation flows, not the schema, and does not prevent trusted direct filesystem access.
- [`dispatchBootstrapTurnStart`](../../apps/server/src/ws.ts) owns first-turn bootstrap: optional `thread.create`, worktree creation through `gitWorkflow.createWorktree`, thread meta update, non-blocking setup launch, and the final turn start. On failure it deletes the created thread but does not remove a created worktree.
- [`ProviderCommandReactor`](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) already resolves one effective thread cwd (`worktreePath ?? project.workspaceRoot`), renames temporary first-turn branches, and starts/resumes provider sessions. It does not create worktrees.
- [`CheckpointReactor`](../../apps/server/src/orchestration/Layers/CheckpointReactor.ts) already couples repository-bound thread conversation rollback with thread-scoped Git checkpoint restoration. Revert today requires both a Git cwd and an active provider session, and its filesystem and provider operations are not atomic. V1 leaves that ordinary thread behavior unchanged and does not expose it through task-level cross-thread or task-root APIs.
- Checkpoint refs are already per-thread (`refs/t3/checkpoints/<base64url(threadId)>/turn/N`) in the repository's common Git dir with per-capture temporary index files.
- [`CheckpointDiffQuery`](../../apps/server/src/checkpointing/CheckpointDiffQuery.ts) already resolves diffs from thread checkout context and thread checkpoint refs.
- [`GitWorkflowService`](../../apps/server/src/git/GitWorkflowService.ts) already exposes thread-cwd Git status, worktree lifecycle, stacked source-control actions, and PR preparation. PR discovery is keyed by the checkout cwd and its current branch.
- [`ThreadStatusIndicators`](../../apps/web/src/components/ThreadStatusIndicators.tsx) already derives a thread PR by matching its stored branch with current checkout status.
- [`worktreeCleanup`](../../apps/web/src/worktreeCleanup.ts) already avoids treating a worktree as orphaned while another thread references the same path. This cleanup is client-driven; it is prior art for the defensive shared-path safety check, not reusable server code.
- [`ProjectSetupScriptRunner`](../../apps/server/src/project/ProjectSetupScriptRunner.ts) currently starts setup in a thread-owned terminal and does not wait for successful exit.
- [`McpHttpServer`](../../apps/server/src/mcp/McpHttpServer.ts) and [`McpSessionRegistry`](../../apps/server/src/mcp/McpSessionRegistry.ts) already serve a local HTTP MCP endpoint with per-thread bearer credentials and a capability set (currently hardcoded to `preview`), injected into the Codex, Claude, Cursor ACP, OpenCode, and Grok adapters. The Cursor SDK adapter has no MCP injection.
- [`ExecutionEnvironmentCapabilities`](../../packages/contracts/src/environment.ts) already advertises optional server capabilities such as `threadSettlement`; `taskThreads` follows the same pattern.
- [`CodexSessionRuntime`](../../apps/server/src/provider/Layers/CodexSessionRuntime.ts) already folds provider-internal collaboration child activity into its parent T3 thread.
- [`ClaudeAdapter`](../../apps/server/src/provider/Layers/ClaudeAdapter.ts) already maps background task/subagent lifecycle into parent-thread runtime activities.
- [`SidebarV2`](../../apps/web/src/components/SidebarV2.tsx) is the target surface for task, user-created thread, agent-created thread, and approved-repository presentation.
