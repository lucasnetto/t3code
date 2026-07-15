import { describe, expect, it } from "vite-plus/test";

import {
  ALL_RUNTIME_MODES,
  getSupportedRuntimeModes,
  normalizeRuntimeMode,
} from "./composerRuntimeModes";

describe("composerRuntimeModes", () => {
  it("keeps every legacy runtime mode when a provider omits capability metadata", () => {
    expect(getSupportedRuntimeModes(undefined)).toEqual(ALL_RUNTIME_MODES);
    expect(getSupportedRuntimeModes({})).toEqual(ALL_RUNTIME_MODES);
  });

  it("limits Cursor SDK sessions to full access", () => {
    const supported = getSupportedRuntimeModes({ supportedRuntimeModes: ["full-access"] });

    expect(supported).toEqual(["full-access"]);
    expect(normalizeRuntimeMode("approval-required", supported)).toBe("full-access");
    expect(normalizeRuntimeMode("full-access", supported)).toBe("full-access");
  });
});
