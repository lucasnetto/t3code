import { describe, expect, it } from "vite-plus/test";

import type { CursorSdkDelta } from "../Services/CursorSdkClient.ts";
import { emptyCursorSdkEventMapperState, mapCursorSdkDelta } from "./CursorSdkEventMapper.ts";

const delta = (value: unknown): CursorSdkDelta => value as CursorSdkDelta;

describe("CursorSdkEventMapper", () => {
  it("maps assistant and thinking deltas without reordering their content", () => {
    const state = emptyCursorSdkEventMapperState();

    expect(mapCursorSdkDelta(state, delta({ type: "text-delta", text: "hello" })).actions).toEqual([
      { type: "assistant.delta", text: "hello" },
    ]);
    expect(
      mapCursorSdkDelta(state, delta({ type: "thinking-delta", text: "reason" })).actions,
    ).toEqual([{ type: "thinking.delta", text: "reason" }]);
  });

  it("associates shell output only through an explicit call id", () => {
    const started = mapCursorSdkDelta(
      emptyCursorSdkEventMapperState(),
      delta({
        type: "tool-call-started",
        callId: "call-1",
        toolCall: { type: "shell", args: { command: "pwd" } },
      }),
    );
    const ignored = mapCursorSdkDelta(
      started.state,
      delta({ type: "shell-output-delta", event: { text: "/tmp" } }),
    );
    const associated = mapCursorSdkDelta(
      ignored.state,
      delta({ type: "shell-output-delta", event: { callId: "call-1", text: "/tmp" } }),
    );

    expect(ignored.actions).toEqual([]);
    expect(associated.actions).toEqual([
      expect.objectContaining({
        type: "tool.lifecycle",
        callId: "call-1",
        itemType: "command_execution",
        detail: "/tmp",
      }),
    ]);
  });

  it("emits a terminal tool action and a plan update for updateTodos", () => {
    const completed = mapCursorSdkDelta(
      emptyCursorSdkEventMapperState(),
      delta({
        type: "tool-call-completed",
        callId: "todos-1",
        toolCall: {
          type: "updateTodos",
          args: { todos: [{ content: "Ship it", status: "done" }] },
          result: { status: "success", value: {} },
        },
      }),
    );

    expect(completed.actions).toEqual([
      expect.objectContaining({ type: "tool.lifecycle", callId: "todos-1", status: "completed" }),
      { type: "plan.updated", plan: [{ step: "Ship it", status: "completed" }] },
    ]);
  });

  it("turns unknown delta types into bounded diagnostics", () => {
    expect(
      mapCursorSdkDelta(emptyCursorSdkEventMapperState(), delta({ type: "future-delta" })).actions,
    ).toEqual([{ type: "diagnostic.unknown", deltaType: "future-delta" }]);
  });
});
