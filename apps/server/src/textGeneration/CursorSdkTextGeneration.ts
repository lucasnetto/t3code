import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  CursorSdkAgent,
  CursorSdkClientShape,
  CursorSdkStore,
} from "../provider/Services/CursorSdkClient.ts";
import { classifyCursorSdkError } from "../provider/sdk/CursorSdkErrors.ts";
import { resolveCursorSdkModelSelection } from "../provider/sdk/CursorSdkModels.ts";
import { safeCursorSdkCause } from "../provider/sdk/CursorSdkErrors.ts";
import {
  acquireInterruptibleResource,
  releaseCursorSdkAgent,
} from "../provider/sdk/CursorSdkResource.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const TIMEOUT_MS = 180_000;
type CursorSdkTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeCursorSdkTextGeneration = Effect.fn("makeCursorSdkTextGeneration")(
  (input: {
    readonly apiKey: string | undefined;
    readonly client: CursorSdkClientShape;
    readonly getStore: (
      operation: CursorSdkTextGenerationOperation,
    ) => Effect.Effect<CursorSdkStore, TextGenerationError>;
  }) =>
    Effect.sync(() => {
      const runJson = <S extends Schema.Top>(request: {
        readonly operation: CursorSdkTextGenerationOperation;
        readonly cwd: string;
        readonly prompt: string;
        readonly outputSchema: S;
        readonly modelSelection: ModelSelection;
      }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
        Effect.gen(function* () {
          if (!input.apiKey) {
            return yield* new TextGenerationError({
              operation: request.operation,
              detail: "CURSOR_API_KEY is required for Cursor SDK text generation.",
            });
          }
          const apiKey = input.apiKey;
          const store = yield* input.getStore(request.operation);
          const model = resolveCursorSdkModelSelection(request.modelSelection);
          const releaseAgent = (agent: CursorSdkAgent) =>
            releaseCursorSdkAgent({
              agent,
              secrets: [apiKey],
              onFailure: (failure) =>
                Effect.logWarning("Failed to dispose short-lived Cursor SDK agent.", {
                  operation: request.operation,
                  ...failure,
                }),
            });
          const generate = Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* acquireInterruptibleResource({
                acquire: () =>
                  input.client.createAgent({
                    apiKey,
                    model,
                    local: { cwd: request.cwd, store: store.value, autoReview: false },
                    mode: "agent",
                  }),
                mapError: (cause) =>
                  new TextGenerationError({
                    operation: request.operation,
                    detail: "Failed to create the short-lived Cursor SDK agent.",
                    cause: safeCursorSdkCause(cause, [apiKey]),
                  }),
                release: releaseAgent,
              });
              return yield* Effect.tryPromise({
                try: async () => {
                  const run = await agent.send(request.prompt, { model, mode: "agent" });
                  return run.wait();
                },
                catch: (cause) =>
                  new TextGenerationError({
                    operation: request.operation,
                    detail: "Cursor SDK text generation failed.",
                    cause: safeCursorSdkCause(cause, [apiKey]),
                  }),
              });
            }),
          );
          const result = yield* generate.pipe(
            Effect.timeoutOption(TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new TextGenerationError({
                      operation: request.operation,
                      detail: "Cursor SDK text generation timed out.",
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
          if (result.status !== "finished" || !result.result?.trim()) {
            const resultError = result.error
              ? classifyCursorSdkError(result.error, [apiKey])
              : undefined;
            return yield* new TextGenerationError({
              operation: request.operation,
              detail: resultError?.message || "Cursor SDK returned empty output.",
            });
          }
          const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
          return yield* decodeOutput(extractJsonObject(result.result)).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: request.operation,
                  detail: "Cursor SDK returned invalid structured output.",
                  cause,
                }),
            ),
          );
        });

      const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
        Effect.fn("CursorSdkTextGeneration.generateCommitMessage")(function* (request) {
          const prompt = buildCommitMessagePrompt({
            branch: request.branch,
            stagedSummary: request.stagedSummary,
            stagedPatch: request.stagedPatch,
            includeBranch: request.includeBranch === true,
          });
          const generated = yield* runJson({
            operation: "generateCommitMessage",
            cwd: request.cwd,
            prompt: prompt.prompt,
            outputSchema: prompt.outputSchema,
            modelSelection: request.modelSelection,
          });
          return {
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          };
        });

      const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
        Effect.fn("CursorSdkTextGeneration.generatePrContent")(function* (request) {
          const prompt = buildPrContentPrompt(request);
          const generated = yield* runJson({
            operation: "generatePrContent",
            cwd: request.cwd,
            prompt: prompt.prompt,
            outputSchema: prompt.outputSchema,
            modelSelection: request.modelSelection,
          });
          return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
        });

      const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
        Effect.fn("CursorSdkTextGeneration.generateBranchName")(function* (request) {
          const prompt = buildBranchNamePrompt(request);
          const generated = yield* runJson({
            operation: "generateBranchName",
            cwd: request.cwd,
            prompt: prompt.prompt,
            outputSchema: prompt.outputSchema,
            modelSelection: request.modelSelection,
          });
          return { branch: sanitizeBranchFragment(generated.branch) };
        });

      const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
        Effect.fn("CursorSdkTextGeneration.generateThreadTitle")(function* (request) {
          const prompt = buildThreadTitlePrompt(request);
          const generated = yield* runJson({
            operation: "generateThreadTitle",
            cwd: request.cwd,
            prompt: prompt.prompt,
            outputSchema: prompt.outputSchema,
            modelSelection: request.modelSelection,
          });
          return { title: sanitizeThreadTitle(generated.title) };
        });

      return {
        generateCommitMessage,
        generatePrContent,
        generateBranchName,
        generateThreadTitle,
      } satisfies TextGeneration.TextGeneration["Service"];
    }),
);
