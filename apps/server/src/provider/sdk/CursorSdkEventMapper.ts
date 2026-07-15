import type { ToolLifecycleItemType } from "@t3tools/contracts";

import type { CursorSdkDelta } from "../Services/CursorSdkClient.ts";

type RuntimeItemStatus = "inProgress" | "completed" | "failed";

export type CursorSdkMappedAction =
  | { readonly type: "assistant.delta"; readonly text: string }
  | { readonly type: "thinking.delta"; readonly text: string }
  | { readonly type: "thinking.completed" }
  | {
      readonly type: "tool.lifecycle";
      readonly callId: string;
      readonly itemType: ToolLifecycleItemType;
      readonly status: RuntimeItemStatus;
      readonly title: string;
      readonly detail?: string | undefined;
      readonly data?: unknown;
    }
  | {
      readonly type: "plan.updated";
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens: number;
      readonly reasoningTokens: number;
    }
  | { readonly type: "diagnostic.unknown"; readonly deltaType: string };

interface TrackedTool {
  readonly itemType: ToolLifecycleItemType;
  readonly title: string;
  readonly data: unknown;
  readonly output: string;
}

export interface CursorSdkEventMapperState {
  readonly tools: ReadonlyMap<string, TrackedTool>;
}

export const emptyCursorSdkEventMapperState = (): CursorSdkEventMapperState => ({
  tools: new Map(),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function boundedJson(value: unknown, limit = 12_000): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text) return undefined;
    return text.length <= limit ? text : `${text.slice(0, limit)}\n…(truncated)`;
  } catch {
    return undefined;
  }
}

function boundedData(value: unknown): unknown {
  const encoded = boundedJson(value);
  if (!encoded) return undefined;
  try {
    return JSON.parse(encoded.replace(/\n…\(truncated\)$/u, ""));
  } catch {
    return encoded;
  }
}

function toolPresentation(toolCall: unknown): Pick<TrackedTool, "itemType" | "title" | "data"> {
  const record = asRecord(toolCall);
  const kind = readString(record.type) ?? readString(record.name) ?? "tool";
  const itemType: ToolLifecycleItemType =
    kind === "shell"
      ? "command_execution"
      : kind === "write" || kind === "edit" || kind === "delete"
        ? "file_change"
        : kind === "mcp"
          ? "mcp_tool_call"
          : kind === "task"
            ? "collab_agent_tool_call"
            : "dynamic_tool_call";
  const args = asRecord(record.args);
  const title =
    readString(record.title) ??
    readString(args.command) ??
    readString(args.path) ??
    readString(args.pattern) ??
    kind;
  return { itemType, title, data: boundedData(toolCall) };
}

function callIdFromRecord(record: Record<string, unknown>): string | undefined {
  return (
    readString(record.callId) ??
    readString(record.call_id) ??
    readString(record.toolCallId) ??
    readString(record.tool_call_id)
  );
}

function shellOutputFromEvent(event: unknown): string | undefined {
  if (typeof event === "string") return event;
  const record = asRecord(event);
  const direct = readString(record.text) ?? readString(record.output) ?? readString(record.value);
  if (direct) return direct;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
  return combined || undefined;
}

function mapTodoStatus(value: unknown): "pending" | "inProgress" | "completed" {
  switch (String(value ?? "").toLowerCase()) {
    case "completed":
    case "done":
      return "completed";
    case "in_progress":
    case "inprogress":
    case "running":
      return "inProgress";
    default:
      return "pending";
  }
}

function planFromToolCall(toolCall: unknown): CursorSdkMappedAction | undefined {
  const record = asRecord(toolCall);
  if (record.type !== "updateTodos") return undefined;
  const todos = asRecord(record.args).todos;
  if (!Array.isArray(todos)) return undefined;
  const plan = todos.flatMap((todo) => {
    const entry = asRecord(todo);
    const step = readString(entry.content) ?? readString(entry.text) ?? readString(entry.title);
    return step ? [{ step, status: mapTodoStatus(entry.status) }] : [];
  });
  return plan.length > 0 ? { type: "plan.updated", plan } : undefined;
}

export function mapCursorSdkDelta(
  state: CursorSdkEventMapperState,
  delta: CursorSdkDelta,
): {
  readonly state: CursorSdkEventMapperState;
  readonly actions: ReadonlyArray<CursorSdkMappedAction>;
} {
  const record = asRecord(delta);
  const deltaType = readString(record.type) ?? "unknown";
  switch (deltaType) {
    case "text-delta":
      return {
        state,
        actions:
          typeof record.text === "string" ? [{ type: "assistant.delta", text: record.text }] : [],
      };
    case "thinking-delta":
      return {
        state,
        actions:
          typeof record.text === "string" ? [{ type: "thinking.delta", text: record.text }] : [],
      };
    case "thinking-completed":
      return { state, actions: [{ type: "thinking.completed" }] };
    case "tool-call-started":
    case "partial-tool-call": {
      const callId = callIdFromRecord(record);
      if (!callId) return { state, actions: [{ type: "diagnostic.unknown", deltaType }] };
      const presentation = toolPresentation(record.toolCall);
      const tools = new Map(state.tools);
      const previous = tools.get(callId);
      const tracked = { ...presentation, output: previous?.output ?? "" };
      tools.set(callId, tracked);
      return {
        state: { tools },
        actions: [
          {
            type: "tool.lifecycle",
            callId,
            itemType: tracked.itemType,
            status: "inProgress",
            title: tracked.title,
            ...(tracked.output ? { detail: tracked.output } : {}),
            ...(tracked.data !== undefined ? { data: tracked.data } : {}),
          },
        ],
      };
    }
    case "shell-output-delta": {
      const event = asRecord(record.event);
      const callId = callIdFromRecord(event);
      const output = shellOutputFromEvent(record.event);
      if (!callId || !output) return { state, actions: [] };
      const previous = state.tools.get(callId);
      if (!previous) return { state, actions: [] };
      const tools = new Map(state.tools);
      const tracked = {
        ...previous,
        output: `${previous.output}${previous.output ? "\n" : ""}${output}`.slice(-20_000),
      };
      tools.set(callId, tracked);
      return {
        state: { tools },
        actions: [
          {
            type: "tool.lifecycle",
            callId,
            itemType: tracked.itemType,
            status: "inProgress",
            title: tracked.title,
            detail: tracked.output,
            ...(tracked.data !== undefined ? { data: tracked.data } : {}),
          },
        ],
      };
    }
    case "tool-call-completed": {
      const callId = callIdFromRecord(record);
      if (!callId) return { state, actions: [{ type: "diagnostic.unknown", deltaType }] };
      const previous = state.tools.get(callId);
      const presentation = previous ?? { ...toolPresentation(record.toolCall), output: "" };
      const result = asRecord(asRecord(record.toolCall).result);
      const status = result.status === "error" ? "failed" : "completed";
      const resultDetail = boundedJson(result.status === "error" ? result.error : result.value);
      const detail = [presentation.output, resultDetail].filter(Boolean).join("\n").slice(-20_000);
      const tools = new Map(state.tools);
      tools.delete(callId);
      const plan = planFromToolCall(record.toolCall);
      return {
        state: { tools },
        actions: [
          {
            type: "tool.lifecycle",
            callId,
            itemType: presentation.itemType,
            status,
            title: presentation.title,
            ...(detail ? { detail } : {}),
            ...(presentation.data !== undefined ? { data: presentation.data } : {}),
          },
          ...(plan ? [plan] : []),
        ],
      };
    }
    case "summary":
      return {
        state,
        actions:
          typeof record.summary === "string"
            ? [{ type: "thinking.delta", text: record.summary }]
            : [],
      };
    case "turn-ended": {
      const usage = asRecord(record.usage);
      return {
        state,
        actions: [
          {
            type: "usage",
            inputTokens: Number(usage.inputTokens ?? 0),
            outputTokens: Number(usage.outputTokens ?? 0),
            cachedInputTokens: Number(usage.cacheReadTokens ?? 0),
            reasoningTokens: Number(usage.reasoningTokens ?? 0),
          },
        ],
      };
    }
    case "summary-started":
    case "summary-completed":
    case "token-delta":
    case "user-message-appended":
    case "step-started":
    case "step-completed":
      return { state, actions: [] };
    default:
      return { state, actions: [{ type: "diagnostic.unknown", deltaType }] };
  }
}
