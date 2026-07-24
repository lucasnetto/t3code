import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ArchivedThreadActionControl } from "./ArchivedThreadActionControl";

describe("ArchivedThreadActionControl", () => {
  it("does not expose archived-thread mutations for agent-created task threads", () => {
    const html = renderToStaticMarkup(
      <ArchivedThreadActionControl readOnly onUnarchive={vi.fn()} />,
    );

    expect(html).toContain("Agent-created archived thread is read-only");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Unarchive");
  });

  it("keeps unarchive available for ordinary and user-created threads", () => {
    const html = renderToStaticMarkup(
      <ArchivedThreadActionControl readOnly={false} onUnarchive={vi.fn()} />,
    );

    expect(html).toContain("<button");
    expect(html).toContain("Unarchive");
  });
});
