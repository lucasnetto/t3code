import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentThreadLineage, agentThreadLineageLabel } from "./AgentThreadLineage";

describe("AgentThreadLineage", () => {
  it("shows the creator title and exposes the durable spawning turn accessibly", () => {
    const markup = renderToStaticMarkup(
      <AgentThreadLineage parentTitle="Plan and coordinate" turnId="turn-42" />,
    );

    expect(markup).toContain("Agent · from Plan and coordinate");
    expect(markup).toContain(
      'aria-label="Agent thread created from Plan and coordinate, spawning turn turn-42"',
    );
    expect(markup).toContain(
      'title="Agent thread created from Plan and coordinate, spawning turn turn-42"',
    );
    expect(markup).not.toContain("provider");
  });

  it("provides the same provider-neutral detail for compact sidebar rows", () => {
    expect(agentThreadLineageLabel("Investigate cleanup", "turn-cleanup")).toBe(
      "Agent thread created from Investigate cleanup, spawning turn turn-cleanup",
    );
  });
});
