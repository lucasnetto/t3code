import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
  serializeProviderSkillInvocation,
} from "./providerSkillPresentation";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("serializeProviderSkillInvocation", () => {
  it("uses Cursor slash syntax", () => {
    expect(
      serializeProviderSkillInvocation(ProviderDriverKind.make("cursor"), {
        name: "review-follow-up",
      }),
    ).toBe("/review-follow-up");
    expect(
      serializeProviderSkillInvocation(ProviderDriverKind.make("cursorSdk"), {
        name: "review-follow-up",
      }),
    ).toBe("/review-follow-up");
  });

  it("preserves Codex dollar syntax", () => {
    expect(
      serializeProviderSkillInvocation(ProviderDriverKind.make("codex"), {
        name: "review-follow-up",
      }),
    ).toBe("$review-follow-up");
  });
});

describe("formatProviderSkillInstallSource", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      formatProviderSkillInstallSource({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("App");
  });

  it("maps standard scopes to user-facing labels", () => {
    expect(
      formatProviderSkillInstallSource({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("Personal");
    expect(
      formatProviderSkillInstallSource({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("System");
    expect(
      formatProviderSkillInstallSource({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("Project");
  });
});
