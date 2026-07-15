import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";

export const ALL_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

export const RUNTIME_MODE_PRESENTATION = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  "auto-review": {
    label: "Auto-review",
    description: "Let the provider review and approve safe actions.",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
} as const satisfies Record<RuntimeMode, { readonly label: string; readonly description: string }>;

export function getSupportedRuntimeModes(
  snapshot: Pick<ServerProvider, "supportedRuntimeModes"> | null | undefined,
): ReadonlyArray<RuntimeMode> {
  return snapshot?.supportedRuntimeModes?.length
    ? snapshot.supportedRuntimeModes
    : ALL_RUNTIME_MODES;
}

export function normalizeRuntimeMode(
  mode: RuntimeMode,
  supportedModes: ReadonlyArray<RuntimeMode>,
): RuntimeMode {
  return supportedModes.includes(mode) ? mode : (supportedModes[0] ?? "full-access");
}
