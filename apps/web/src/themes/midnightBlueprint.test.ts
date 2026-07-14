import { getSharedHighlighter } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";
import { MIDNIGHT_BLUEPRINT_DIFF_THEME_NAME } from "./midnightBlueprint";

describe("Midnight Blueprint syntax theme", () => {
  it("loads through Pierre's Shiki highlighter", async () => {
    const highlighter = await getSharedHighlighter({
      themes: [MIDNIGHT_BLUEPRINT_DIFF_THEME_NAME],
      langs: ["typescript"],
      preferredHighlighter: "shiki-js",
    });

    const html = highlighter.codeToHtml("const answer = 42;", {
      lang: "typescript",
      theme: MIDNIGHT_BLUEPRINT_DIFF_THEME_NAME,
    });

    expect(html).toContain(MIDNIGHT_BLUEPRINT_DIFF_THEME_NAME);
    expect(html.toLowerCase()).toContain("#569cd6");
  });
});
