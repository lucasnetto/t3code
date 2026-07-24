# Multi-repository task MCP read tools

The provider-neutral MCP server now exposes bounded, task-scoped inspection
tools:

- list approved repositories;
- list task threads and lineage;
- inspect one thread's current status;
- page through a bounded transcript;
- read a bounded Git checkpoint diff.

Every handler re-authorizes the provider credential, calling thread, active
task, and target thread. Opaque list and transcript cursors plus hard response
caps keep provider output bounded. Agent-created or standalone sessions cannot
invoke the tools even though all MCP tool definitions share one server
transport.

Repository and thread lists return 50 items by default and never more than 100
items per call. Their versioned opaque cursors bind the continuation to the
current task, list kind, prior item identity, and prior projection index. A
cursor therefore continues safely when later items are appended, but is
rejected if it belongs to another task or tool or if the projection reordered
or removed its anchor. This avoids silently skipping entries when a provider
continues a changing list.

Thread list and status summaries expose an explicit target variant:
`{ kind: "task-root" }` for the coordinator workspace or
`{ kind: "repository", projectId }` for repository-bound work. This replaces
the ambiguous top-level `projectId`, so the internal project used to model a
task workspace is never presented to providers as an approved repository.
Repository target IDs retain their existing project identity and approval
semantics.

Thread origin is an explicit variant: user-created threads return
`{ kind: "user" }`, while agent-created threads return
`{ kind: "agent", threadId, turnId }`. The agent variant identifies both the
spawning thread and the exact durable turn that created the child, without
exposing provider session or runtime internals.

Transcript pagination uses a versioned opaque cursor anchored to the current
message identity, projection index, update timestamp, and JavaScript UTF-16
character offset. Oversized messages therefore continue across pages without
losing their suffix. A cursor is rejected when its anchor is no longer present
or stable instead of silently resuming at the wrong message. Cursors issued by
the earlier index-only implementation are intentionally rejected because they
cannot identify a partially consumed message safely.

Messages still marked as streaming are excluded from paginated reads because
the projection does not retain immutable streaming snapshots. They become
visible on a fresh read after the final stable message version is projected.
`maxChars` follows JavaScript string length and slice semantics (UTF-16 code
units), and every non-empty page advances by at least one code unit.

Task read tools expose only active, non-deleted, non-archived task threads.
Archived threads are filtered from the task scope before list, status,
transcript, and diff handling, while deleted threads remain absent from the
active shell projection. Naming either kind returns the same out-of-scope error
as any inaccessible thread, so list and detail operations cannot disagree
about what the provider may inspect. Human archive management remains available
through its existing non-MCP UI and orchestration commands.

`task_get_thread_diff` exposes stable, safe failure reasons instead of making
providers interpret backend error text: `checkout-unavailable`,
`invalid-range`, `checkpoint-unavailable`, and `diff-failed`. The checkpoint
query verifies the projected workspace through the existing checkpoint/VCS
service before diffing, so a stale checkout path or non-Git directory is
reported without attempting to read checkpoint refs. Known range and
checkpoint-ref errors preserve their categories at the MCP boundary; projection
and VCS backend failures remain intentionally generalized as `diff-failed` so
internal paths, commands, and storage details are not exposed.

## Focused test matrix

| Read surface    | Successful and bounded behavior                                                                                                                               | Authorization and failure behavior                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository list | Pages only approved repositories through a default 50 / maximum 100 item cap; excludes unapproved projects and the internal task workspace                    | Rejects invalid, cross-tool, cross-task, and stale opaque cursors; shared task-capability gate; agent-created caller rejection                                               |
| Thread list     | Pages active task-root and repository threads through a default 50 / maximum 100 item cap, including target and explicit user or spawning thread/turn lineage | Rejects invalid, cross-tool, cross-task, and stale opaque cursors; excludes archived, deleted-from-projection, and cross-task threads; shared capability gate                |
| Thread status   | Reports task-root and repository status variants with explicit user or spawning thread/turn lineage                                                           | Rejects archived, deleted, and cross-task IDs; shared capability gate                                                                                                        |
| Transcript      | Exercises handler cursor continuation, oversized-message paging, exact boundaries, streaming omission, UTF-16 offsets, and the 1–16,000 character cap         | Rejects archived, deleted, and cross-task IDs, invalid/legacy/stale cursors, and missing capability                                                                          |
| Checkpoint diff | Exercises default and explicit ranges plus the 32,000 character cap                                                                                           | Covers `checkout-unavailable`, `invalid-range`, `checkpoint-unavailable`, and generalized `diff-failed`; rejects archived, deleted, cross-task, and capability-denied access |
