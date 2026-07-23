# Multi-repository task MCP read tools

The provider-neutral MCP server now exposes bounded, task-scoped inspection
tools:

- list approved repositories;
- list task threads and lineage;
- inspect one thread's current status;
- page through a bounded transcript;
- read a bounded Git checkpoint diff.

Every handler re-authorizes the provider credential, calling thread, active
task, and target thread. Opaque transcript cursors and hard response caps keep
provider output bounded. Agent-created or standalone sessions cannot invoke
the tools even though all MCP tool definitions share one server transport.
