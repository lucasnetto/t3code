# Multi-repository task MCP capabilities

Provider-scoped MCP credentials now carry a `task` capability in addition to
the existing `preview` capability.

The capability is derived from durable thread lineage when the credential is
issued:

- user-created threads inside an active task receive `preview` and `task`;
- agent-created task threads receive only `preview`;
- standalone threads and projection lookup failures receive only `preview`.

This keeps durable T3 thread delegation non-recursive while preserving the
ordinary provider tools and browser preview available to every provider
session.
