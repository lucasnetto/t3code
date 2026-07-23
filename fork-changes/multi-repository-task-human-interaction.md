# Multi-repository task human interaction policy

Agent-created task threads are durable and readable, but are no longer directly
human-mutable.

The web thread view replaces the composer and checkout toolbar with a read-only
lineage banner. It hides direct revert affordances, model controls, project
scripts, terminal controls, and checkout mutation controls. An active agent
thread retains an emergency Stop action.

The WebSocket command boundary independently rejects human commands targeting
an agent-created thread, including messages, metadata changes, archive/delete,
settlement, approval/input responses, and direct revert. Turn interruption and
session stop remain allowed as emergency safety actions. Internal task MCP
coordination dispatches through the orchestration engine and is not mistaken
for a human client mutation.

Task threads are labeled in the sidebar. Agent-created children are indented
and show their spawning thread, while user-created task threads remain peers.
