import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";
import { PROVIDER_OPTIONS } from "../../session-logic";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "./providerDriverMeta";

describe("Cursor SDK provider presentation", () => {
  it("appears as a distinct provider in settings and session creation", () => {
    const driver = ProviderDriverKind.make("cursorSdk");

    expect(PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver]).toMatchObject({
      value: driver,
      label: "Cursor SDK",
      badgeLabel: "Early Access",
    });
    expect(PROVIDER_OPTIONS).toContainEqual(
      expect.objectContaining({ value: driver, label: "Cursor SDK", available: true }),
    );
  });
});
