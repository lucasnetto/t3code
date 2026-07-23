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
and repository approval. Agent-created threads do not receive the MCP
capability needed to invoke these tools recursively.
