import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";

export const ALL_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

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
