import type { Thread } from "../types";

type ThreadTaskContextCarrier = Pick<Thread, "taskContext">;

export type ThreadUiReadOnlyReason = "agent-created" | "unresolved-task-context";

export function isAgentCreatedTaskThread(
  thread: ThreadTaskContextCarrier | null | undefined,
): boolean {
  return thread?.taskContext?.createdBy.kind === "agent";
}

/**
 * The live shell is the authoritative source for whether a routed server thread
 * belongs to a task. Detail state is retained independently and can briefly
 * outlive an archived shell, or be restored from an older cache on reload.
 *
 * Treat that gap as read-only until the shell resolves. Once it does, ordinary
 * standalone and user-created task threads keep their existing mutable UI.
 */
export function resolveThreadUiReadOnlyReason(input: {
  readonly routeKind: "draft" | "server";
  readonly thread: ThreadTaskContextCarrier | null | undefined;
  readonly shell: ThreadTaskContextCarrier | null | undefined;
}): ThreadUiReadOnlyReason | null {
  if (input.routeKind === "draft") {
    return null;
  }

  if (isAgentCreatedTaskThread(input.shell) || isAgentCreatedTaskThread(input.thread)) {
    return "agent-created";
  }

  if (input.thread !== null && input.thread !== undefined && input.shell == null) {
    return "unresolved-task-context";
  }

  return null;
}
