import { describe, expect, it } from "@effect/vitest";
import { TaskId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  isMobileThreadUiActionAllowed,
  resolveMobileThreadUiPolicy,
  type MobileThreadUiAction,
} from "./threadUiPolicy";

const MUTATION_ACTIONS: ReadonlyArray<MobileThreadUiAction> = [
  "change-environment",
  "change-model",
  "change-runtime",
  "mutate-git",
  "open-terminal",
  "respond-to-request",
  "run-project-script",
  "send-message",
];

describe("mobile thread UI policy", () => {
  it("makes agent-created task threads read-only while retaining inspection and emergency Stop", () => {
    const policy = resolveMobileThreadUiPolicy({
      taskContext: {
        taskId: TaskId.make("task-1"),
        createdBy: {
          kind: "agent",
          threadId: ThreadId.make("thread-coordinator"),
          turnId: TurnId.make("turn-1"),
        },
      },
    });

    expect(policy).toEqual({ readOnly: true, reason: "agent-created" });
    for (const action of MUTATION_ACTIONS) {
      expect(isMobileThreadUiActionAllowed(policy, action), action).toBe(false);
    }
    expect(isMobileThreadUiActionAllowed(policy, "inspect-files")).toBe(true);
    expect(isMobileThreadUiActionAllowed(policy, "inspect-history")).toBe(true);
    expect(isMobileThreadUiActionAllowed(policy, "stop")).toBe(true);
  });

  it("keeps user-created task threads mutable", () => {
    const policy = resolveMobileThreadUiPolicy({
      taskContext: {
        taskId: TaskId.make("task-1"),
        createdBy: { kind: "user" },
      },
    });

    expect(policy).toEqual({ readOnly: false, reason: null });
    for (const action of MUTATION_ACTIONS) {
      expect(isMobileThreadUiActionAllowed(policy, action), action).toBe(true);
    }
  });

  it("keeps standalone threads mutable", () => {
    const policy = resolveMobileThreadUiPolicy({});

    expect(policy).toEqual({ readOnly: false, reason: null });
    expect(isMobileThreadUiActionAllowed(policy, "send-message")).toBe(true);
    expect(isMobileThreadUiActionAllowed(policy, "mutate-git")).toBe(true);
  });
});
