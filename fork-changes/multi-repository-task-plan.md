# Multi-repository task architecture plan

- Added the proposed multi-repository task and durable agent-thread architecture under `docs/architecture/multi-repo-tasks.md`.
- Defined tasks as stable managed directories with explicit approved repositories, multiple fully interactive user-created threads, and no primary repository or special orchestrator runtime.
- Kept branch, worktree path, checkpoints, diffs, filesystem revert, source-control actions, and discovered pull-request state on ordinary threads instead of introducing a workstream or PR aggregate.
- Distinguished immutable user-created and agent-created thread origins. Agent-created threads use the caller-supplied initial message and remain durable and readable without a human composer or direct mutation controls.
- Made repository selection authorization-only and deferred worktree creation until a repository-bound thread is created beneath the task directory.
- Enforced one thread per checkout: each thread is a unit of work that would eventually become a PR, and review or assistance happens through provider-native child agents inside the owning thread. Existing reference-aware cleanup is retained as defense in depth.
- Exposed agent-thread revert as a task/user-thread management action while retaining existing combined conversation/filesystem revert for repository threads and adding a Git-independent conversation revert path for task-root threads.
- Kept existing branch-based PR discovery without persisting separate task or thread PR metadata.
- Restricted task tools to user-created threads while keeping ordinary repository/provider tools and provider-native subagents available to agent-created threads.
- Defined completion to settle every task thread while allowing explicitly retained local-only work without a pushed branch or PR.
- Kept current non-blocking project setup behavior and made global worktree-root changes apply only to new tasks rather than relocating existing paths.
- Retained current thread execution and Git services, safe task completion, managed cleanup, and restart recovery as implementation foundations.
- Revised the plan after verifying it against the current implementation: corrected first-turn worktree bootstrap ownership (`dispatchBootstrapTurnStart` in `ws.ts`, not `ProviderCommandReactor`), grounded task roots in the server worktree base directory instead of a nonexistent user setting, and noted that bootstrap compensation currently leaves created worktrees on disk.
- Specified previously open behavior: bounded re-invocable `task.wait_for_threads` and provider-session resumption before task-level revert of stopped threads.
- Removed durable checkout sharing from scope entirely (spawn-time reuse, shared-checkout warnings, shared revert semantics, and sharing indicators), simplifying tools, cleanup, and the sidebar to a one-thread-one-checkout model.
- Grounded task tools in the existing local MCP server (`/mcp`, per-thread bearer credentials) with a new capability alongside `preview`, noted the Cursor SDK adapter's missing MCP injection, and anchored the `taskThreads` capability on the existing `ExecutionEnvironmentCapabilities` pattern.
- Scoped previously implicit work: extending the closed orchestration aggregate union for the task kind, a project-visibility marker for the hidden task workspace project, and server-side worktree cleanup machinery distinct from today's client-driven orphan cleanup.
