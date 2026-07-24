# Multi-repository task MCP capabilities

Provider-scoped MCP credentials now carry a `task` capability in addition to
the existing `preview` capability.

The capability is derived from durable thread lineage when the credential is
issued:

- user-created threads inside an active task receive `preview` and `task`;
- agent-created task threads receive only `preview`;
- standalone threads and projection lookup failures receive only `preview`.

The MCP session registry now requires the projection query service at layer
construction instead of treating missing projection authority as a valid
preview-only mode. Standalone and unknown threads remain preview-only through
explicit `getThreadShellById` results, while production server wiring supplies
the same durable projection authority used by the rest of orchestration.

Capability enforcement is centralized in the MCP invocation context for both
`preview` and `task`. Preview callers retain their existing
`PreviewAutomationUnavailableError` contract, while task callers receive a
capability-neutral typed error carrying the denied capability and credential
scope. This lets task toolkits reuse the same guard without duplicating set
membership checks or broadening any issued credential.

This keeps durable T3 thread delegation non-recursive while preserving the
ordinary provider tools and browser preview available to every provider
session.
