import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const preferences = vi.hoisted(() => ({ simple: true }));
vi.mock("../threads/use-simple-mode-enabled", () => ({
  useSimpleModeEnabled: () => preferences.simple,
}));

import { useWorkspaceTabs, WorkspaceTabsProvider } from "./WorkspaceTabsContext";

let root: Root | undefined;
function ObserveWorkspace({
  onRender,
}: {
  onRender: (value: ReturnType<typeof useWorkspaceTabs>) => void;
}) {
  onRender(useWorkspaceTabs());
  return null;
}
function renderWorkspace(onRender: (value: ReturnType<typeof useWorkspaceTabs>) => void) {
  act(() => {
    root!.render(
      <WorkspaceTabsProvider>
        <ObserveWorkspace onRender={onRender} />
      </WorkspaceTabsProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preferences.simple = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe("workspace navigation in Simple Mode", () => {
  it("offers tasks and ignores requests to select hidden pull requests", () => {
    let workspace: ReturnType<typeof useWorkspaceTabs>;
    renderWorkspace((value) => {
      workspace = value;
    });
    expect(workspace!.availableTabs).toEqual(["threads"]);
    act(() => workspace!.dispatch({ type: "select", tab: "pullRequests" }));
    expect(workspace!.state.selectedTab).toBe("threads");
  });

  it("returns to tasks when Simple Mode is enabled and retains independent search", () => {
    let workspace: ReturnType<typeof useWorkspaceTabs>;
    const observe = (value: ReturnType<typeof useWorkspaceTabs>) => {
      workspace = value;
    };
    preferences.simple = false;
    renderWorkspace(observe);
    expect(workspace!.availableTabs).toEqual(["threads", "pullRequests"]);
    act(() => {
      workspace!.dispatch({ type: "query", query: "my task", tab: "threads" });
      workspace!.dispatch({ type: "select", tab: "pullRequests" });
      workspace!.dispatch({ type: "query", query: "review", tab: "pullRequests" });
    });
    expect(workspace!.state.selectedTab).toBe("pullRequests");
    preferences.simple = true;
    renderWorkspace(observe);
    expect(workspace!.state.selectedTab).toBe("threads");
    expect(workspace!.state.tabs.threads.query).toBe("my task");
    preferences.simple = false;
    renderWorkspace(observe);
    expect(workspace!.state.selectedTab).toBe("threads");
    act(() => workspace!.dispatch({ type: "select", tab: "pullRequests" }));
    expect(workspace!.state.tabs.pullRequests.query).toBe("review");
  });
});
