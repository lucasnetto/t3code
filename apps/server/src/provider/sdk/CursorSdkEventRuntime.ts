import {
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import type { CursorSdkDelta } from "../Services/CursorSdkClient.ts";
import {
  emptyCursorSdkEventMapperState,
  mapCursorSdkDelta,
  type CursorSdkEventMapperState,
  type CursorSdkMappedAction,
} from "./CursorSdkEventMapper.ts";

export interface CursorSdkActiveItem {
  readonly itemType: CanonicalItemType;
  readonly title?: string | undefined;
  completed: boolean;
}

export type CursorSdkDrainMessage =
  | { readonly type: "delta"; readonly delta: CursorSdkDelta }
  | { readonly type: "end" };

type EventStamp = Pick<ProviderRuntimeEvent, "eventId" | "createdAt">;
type EventBase = Pick<ProviderRuntimeEvent, "provider" | "providerInstanceId" | "threadId"> & {
  readonly turnId?: TurnId | undefined;
};

export function makeCursorSdkEventRuntime(input: {
  readonly providerInstanceId: string;
  readonly publishEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, never, never>;
  readonly makeStamp: () => Effect.Effect<EventStamp, never, never>;
  readonly eventBase: (threadId: ThreadId, turnId?: TurnId) => EventBase;
}) {
  const processAction = Effect.fn("CursorSdkEventRuntime.processAction")(function* (actionInput: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly action: CursorSdkMappedAction;
    readonly activeItems: Map<string, CursorSdkActiveItem>;
    readonly assistantItemId: string;
    readonly thinkingItemId: string;
    readonly shouldPublish: () => boolean;
  }) {
    const publish = (event: ProviderRuntimeEvent) =>
      actionInput.shouldPublish() ? input.publishEvent(event) : Effect.void;
    const ensureItemStarted = Effect.fn("CursorSdkEventRuntime.ensureItemStarted")(function* (
      itemId: string,
      itemType: "assistant_message" | "reasoning",
    ) {
      if (actionInput.activeItems.has(itemId)) return;
      actionInput.activeItems.set(itemId, { itemType, completed: false });
      yield* publish({
        type: "item.started",
        ...(yield* input.makeStamp()),
        ...input.eventBase(actionInput.threadId, actionInput.turnId),
        itemId: RuntimeItemId.make(itemId),
        payload: { itemType, status: "inProgress" },
      });
    });

    switch (actionInput.action.type) {
      case "assistant.delta":
        yield* ensureItemStarted(actionInput.assistantItemId, "assistant_message");
        yield* publish({
          type: "content.delta",
          ...(yield* input.makeStamp()),
          ...input.eventBase(actionInput.threadId, actionInput.turnId),
          itemId: RuntimeItemId.make(actionInput.assistantItemId),
          payload: { streamKind: "assistant_text", delta: actionInput.action.text },
          raw: { source: "cursor.sdk.delta", messageType: "text-delta", payload: {} },
        });
        return;
      case "thinking.delta":
        yield* ensureItemStarted(actionInput.thinkingItemId, "reasoning");
        yield* publish({
          type: "content.delta",
          ...(yield* input.makeStamp()),
          ...input.eventBase(actionInput.threadId, actionInput.turnId),
          itemId: RuntimeItemId.make(actionInput.thinkingItemId),
          payload: { streamKind: "reasoning_text", delta: actionInput.action.text },
          raw: { source: "cursor.sdk.delta", messageType: "thinking-delta", payload: {} },
        });
        return;
      case "thinking.completed": {
        const item = actionInput.activeItems.get(actionInput.thinkingItemId);
        if (!item || item.completed) return;
        item.completed = true;
        yield* publish({
          type: "item.completed",
          ...(yield* input.makeStamp()),
          ...input.eventBase(actionInput.threadId, actionInput.turnId),
          itemId: RuntimeItemId.make(actionInput.thinkingItemId),
          payload: { itemType: "reasoning", status: "completed" },
        });
        return;
      }
      case "tool.lifecycle": {
        const existing = actionInput.activeItems.get(actionInput.action.callId);
        if (!existing) {
          yield* publish({
            type: "item.started",
            ...(yield* input.makeStamp()),
            ...input.eventBase(actionInput.threadId, actionInput.turnId),
            itemId: RuntimeItemId.make(actionInput.action.callId),
            payload: {
              itemType: actionInput.action.itemType,
              status: "inProgress",
              title: actionInput.action.title,
              ...(actionInput.action.detail ? { detail: actionInput.action.detail } : {}),
              ...(actionInput.action.data !== undefined ? { data: actionInput.action.data } : {}),
            },
            raw: { source: "cursor.sdk.delta", messageType: "item.started", payload: {} },
          });
        }
        actionInput.activeItems.set(actionInput.action.callId, {
          itemType: actionInput.action.itemType,
          title: actionInput.action.title,
          completed: actionInput.action.status !== "inProgress",
        });
        if (!existing && actionInput.action.status === "inProgress") return;
        const eventType =
          actionInput.action.status === "inProgress" ? "item.updated" : "item.completed";
        yield* publish({
          type: eventType,
          ...(yield* input.makeStamp()),
          ...input.eventBase(actionInput.threadId, actionInput.turnId),
          itemId: RuntimeItemId.make(actionInput.action.callId),
          payload: {
            itemType: actionInput.action.itemType,
            status: actionInput.action.status,
            title: actionInput.action.title,
            ...(actionInput.action.detail ? { detail: actionInput.action.detail } : {}),
            ...(actionInput.action.data !== undefined ? { data: actionInput.action.data } : {}),
          },
          raw: { source: "cursor.sdk.delta", messageType: eventType, payload: {} },
        });
        return;
      }
      case "plan.updated":
        yield* publish({
          type: "turn.plan.updated",
          ...(yield* input.makeStamp()),
          ...input.eventBase(actionInput.threadId, actionInput.turnId),
          payload: { plan: [...actionInput.action.plan] },
        });
        return;
      case "usage": {
        const usedTokens = Math.max(
          0,
          actionInput.action.inputTokens + actionInput.action.outputTokens,
        );
        yield* publish({
          type: "thread.token-usage.updated",
          ...(yield* input.makeStamp()),
          ...input.eventBase(actionInput.threadId, actionInput.turnId),
          payload: {
            usage: {
              usedTokens,
              inputTokens: Math.max(0, actionInput.action.inputTokens),
              cachedInputTokens: Math.max(0, actionInput.action.cachedInputTokens),
              outputTokens: Math.max(0, actionInput.action.outputTokens),
              reasoningOutputTokens: Math.max(0, actionInput.action.reasoningTokens),
            },
          },
        });
        return;
      }
      case "diagnostic.unknown":
        yield* Effect.logDebug("Ignoring unknown Cursor SDK delta", {
          deltaType: actionInput.action.deltaType.slice(0, 128),
          providerInstanceId: input.providerInstanceId,
        });
    }
  });

  const drainDeltas = Effect.fn("CursorSdkEventRuntime.drainDeltas")(function* (drainInput: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly queue: Queue.Dequeue<CursorSdkDrainMessage>;
    readonly activeItems: Map<string, CursorSdkActiveItem>;
    readonly assistantItemId: string;
    readonly thinkingItemId: string;
    readonly shouldPublish: () => boolean;
  }) {
    let mapperState: CursorSdkEventMapperState = emptyCursorSdkEventMapperState();
    while (true) {
      const message = yield* Queue.take(drainInput.queue);
      if (message.type === "end") return;
      const mapped = mapCursorSdkDelta(mapperState, message.delta);
      mapperState = mapped.state;
      for (const action of mapped.actions) {
        yield* processAction({ ...drainInput, action });
      }
    }
  });

  const terminalizeItems = Effect.fn("CursorSdkEventRuntime.terminalizeItems")(
    function* (terminalInput: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly activeItems: Map<string, CursorSdkActiveItem>;
      readonly failed: boolean;
      readonly shouldPublish: () => boolean;
    }) {
      const publish = (event: ProviderRuntimeEvent) =>
        terminalInput.shouldPublish() ? input.publishEvent(event) : Effect.void;
      for (const [itemId, item] of terminalInput.activeItems) {
        if (item.completed) continue;
        item.completed = true;
        yield* publish({
          type: "item.completed",
          ...(yield* input.makeStamp()),
          ...input.eventBase(terminalInput.threadId, terminalInput.turnId),
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType: item.itemType,
            status: terminalInput.failed ? "failed" : "completed",
            ...(item.title ? { title: item.title } : {}),
          },
        });
      }
    },
  );

  return { drainDeltas, terminalizeItems };
}
