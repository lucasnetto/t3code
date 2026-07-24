import type { OrchestrationThreadShell } from "@t3tools/contracts";

type ThreadTaskContextCarrier = Pick<OrchestrationThreadShell, "taskContext">;

export type MobileThreadUiAction =
  | "change-environment"
  | "change-model"
  | "change-runtime"
  | "inspect-files"
  | "inspect-git"
  | "inspect-history"
  | "mutate-git"
  | "mutate-lifecycle"
  | "open-terminal"
  | "respond-to-request"
  | "run-project-script"
  | "send-message"
  | "stop";

export interface MobileThreadUiPolicy {
  readonly readOnly: boolean;
  readonly reason: "agent-created" | null;
}

const MUTABLE_THREAD_UI_POLICY: MobileThreadUiPolicy = {
  readOnly: false,
  reason: null,
};

const AGENT_THREAD_UI_POLICY: MobileThreadUiPolicy = {
  readOnly: true,
  reason: "agent-created",
};

/**
 * Agent-created task threads are read-only in the first-party mobile UI.
 *
 * This is a presentation policy for trusted clients, not a server-side
 * authorization boundary. The shell's durable task lineage is the source of
 * truth; standalone and user-created task threads retain the existing UI.
 */
export function resolveMobileThreadUiPolicy(
  thread: ThreadTaskContextCarrier | null | undefined,
): MobileThreadUiPolicy {
  return thread?.taskContext?.createdBy.kind === "agent"
    ? AGENT_THREAD_UI_POLICY
    : MUTABLE_THREAD_UI_POLICY;
}

export function isMobileThreadUiActionAllowed(
  policy: MobileThreadUiPolicy,
  action: MobileThreadUiAction,
): boolean {
  if (!policy.readOnly) {
    return true;
  }

  switch (action) {
    case "inspect-files":
    case "inspect-git":
    case "inspect-history":
    case "stop":
      return true;
    case "change-environment":
    case "change-model":
    case "change-runtime":
    case "mutate-git":
    case "mutate-lifecycle":
    case "open-terminal":
    case "respond-to-request":
    case "run-project-script":
    case "send-message":
      return false;
  }
}

/**
 * Shared list/archive boundary for lifecycle controls. Callers should use this
 * both when deciding whether to render mutation affordances and immediately
 * before dispatching a command, so recycled or stale row callbacks fail closed.
 */
export function isMobileThreadListMutationAllowed(
  thread: ThreadTaskContextCarrier | null | undefined,
): boolean {
  return isMobileThreadUiActionAllowed(resolveMobileThreadUiPolicy(thread), "mutate-lifecycle");
}

export function isMobileThreadGitMutationAllowed(
  thread: ThreadTaskContextCarrier | null | undefined,
): boolean {
  return isMobileThreadUiActionAllowed(resolveMobileThreadUiPolicy(thread), "mutate-git");
}
