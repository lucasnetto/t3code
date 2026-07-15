import type {
  AgentOptions,
  ConversationTurn,
  InteractionUpdate,
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKModel,
  SDKUser,
  SDKUserMessage,
  SendOptions,
} from "@cursor/sdk";
import type { LocalAgentStore } from "@cursor/sdk";
import * as Context from "effect/Context";

export type CursorSdkAgent = SDKAgent;
export type CursorSdkRun = Run;
export type CursorSdkRunResult = RunResult;
export type CursorSdkDelta = InteractionUpdate;
export type CursorSdkModel = SDKModel;
export type CursorSdkUser = SDKUser;
export type CursorSdkConversationTurn = ConversationTurn;
export type CursorSdkModelSelection = ModelSelection;
export type CursorSdkUserMessage = SDKUserMessage;
export type CursorSdkSendOptions = SendOptions;
export type CursorSdkAgentOptions = AgentOptions;

export interface CursorSdkStore {
  readonly value: LocalAgentStore;
  readonly dispose: () => Promise<void>;
}

export interface CursorSdkClientShape {
  readonly openStore: (input: {
    readonly workspaceRef: string;
    readonly stateRoot: string;
  }) => Promise<CursorSdkStore>;
  readonly createAgent: (options: AgentOptions) => Promise<SDKAgent>;
  readonly resumeAgent: (agentId: string, options: Partial<AgentOptions>) => Promise<SDKAgent>;
  readonly me: (apiKey: string) => Promise<SDKUser>;
  readonly listModels: (apiKey: string) => Promise<ReadonlyArray<SDKModel>>;
  readonly listRuns: (input: {
    readonly agentId: string;
    readonly cwd: string;
    readonly store: LocalAgentStore;
  }) => Promise<ReadonlyArray<Run>>;
  readonly getRun: (input: {
    readonly runId: string;
    readonly cwd: string;
    readonly store: LocalAgentStore;
  }) => Promise<Run>;
}

const liveClient: CursorSdkClientShape = {
  openStore: async ({ workspaceRef, stateRoot }) => {
    const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
    const store = await SqliteLocalAgentStore.open({ workspaceRef, stateRoot });
    return {
      value: store,
      dispose: () => store.dispose(),
    };
  },
  createAgent: async (options) => {
    const { Agent } = await import("@cursor/sdk");
    return Agent.create(options);
  },
  resumeAgent: async (agentId, options) => {
    const { Agent } = await import("@cursor/sdk");
    return Agent.resume(agentId, options);
  },
  me: async (apiKey) => {
    const { Cursor } = await import("@cursor/sdk");
    return Cursor.me({ apiKey });
  },
  listModels: async (apiKey) => {
    const { Cursor } = await import("@cursor/sdk");
    return Cursor.models.list({ apiKey });
  },
  listRuns: async ({ agentId, cwd, store }) => {
    const { Agent } = await import("@cursor/sdk");
    const result = await Agent.listRuns(agentId, { runtime: "local", cwd, store });
    return result.items;
  },
  getRun: async ({ runId, cwd, store }) => {
    const { Agent } = await import("@cursor/sdk");
    return Agent.getRun(runId, { runtime: "local", cwd, store });
  },
};

/**
 * Injectable boundary around the Cursor package. Its default implementation
 * imports the SDK lazily so disabled instances and ordinary unit tests do not
 * load the native local-agent runtime.
 */
export class CursorSdkClient extends Context.Reference<CursorSdkClientShape>(
  "t3/provider/Services/CursorSdkClient",
  { defaultValue: () => liveClient },
) {}
