# Multi-repository task human interaction policy

Agent-created task threads are durable and readable. The first-party web UI
treats them as read-only, while paired clients remain trusted operators and the
server does not make this presentation policy an authorization boundary.

The web thread view replaces the composer and checkout toolbar with a read-only
lineage banner. It hides direct revert affordances, model controls, project
scripts, terminal controls, external-editor actions, and checkout mutation
controls. File surfaces remain available as read-only viewers. Existing
terminal drawers and right-panel terminal surfaces are dismissed when the
active thread becomes agent-created. An active agent thread retains an
emergency Stop action.

Keyboard shortcuts and callback boundaries in the first-party UI also suppress
terminal creation/toggling/splitting/closing, project-script execution and
editing, model selection, file edits, markdown task-list edits, and external
editor launches. Diff/status viewing, history, navigation, copying, previews,
and emergency Stop remain available.

Thread-detail state and live shell state resolve independently. If a direct
navigation, reload, archive, or delete leaves retained detail visible without
its authoritative shell, the web view temporarily fails closed and labels the
thread context as being verified. Resolved standalone and user-created task
threads remain mutable. Archived agent-created task threads are also labeled
read-only in Settings and do not expose unarchive, delete, or context-menu
actions.

This is intentionally not server-side enforcement. Direct API use and manual
filesystem intervention remain possible for a trusted paired client, subject
to the provider runtime permission selected for model operations. Direct API
commands still pass through the existing protocol schema and orchestration
decider invariants; only the first-party UI's agent-thread mutation affordances
are suppressed.

Task threads are labeled in the sidebar. Agent-created children are indented
and show their spawning thread, while user-created task threads remain peers.
Both sidebar variants suppress inline/double-click rename, archive or
settle/un-settle controls, destructive row actions, and destructive bulk
actions for agent-created task threads. Mixed bulk selections fail closed to
local unread-state changes only. Navigation, PR/status inspection, copied
identifiers and paths, and other read-only row metadata remain available.
