import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";

const noop = vi.fn();

function renderEmptyPanel(terminalAvailable: boolean) {
  return renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      surfaces={[]}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      browserAvailable
      diffAvailable
      filesAvailable
      terminalAvailable={terminalAvailable}
    >
      <div>content</div>
    </RightPanelTabs>,
  );
}

describe("RightPanelTabs agent-thread mutation controls", () => {
  it("renders the terminal surface action disabled for an agent-created task thread", () => {
    const html = renderEmptyPanel(false);

    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>[\s\S]*?Terminal/);
    expect(html).toContain("Browse and read workspace files.");
    expect(html).toContain("Review changes in this thread.");
  });

  it("keeps the terminal surface action available for ordinary threads", () => {
    const html = renderEmptyPanel(true);

    expect(html).not.toMatch(/<button[^>]*aria-disabled="true"[^>]*>[\s\S]*?Terminal/);
  });
});
