// @vitest-environment jsdom
import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ simple: true, queriesStarted: 0 }));
vi.mock("../threads/use-simple-mode-enabled", () => ({
  useSimpleModeEnabled: () => state.simple,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../../components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../../components/EmptyState", () => ({
  EmptyState: ({ detail }: { detail: string }) => createElement("p", null, detail),
}));

import { withAdvancedMode } from "./AdvancedModeRoute";

function ProtectedScreen({ title }: { title: string }) {
  useEffect(() => {
    state.queriesStarted += 1;
  }, []);
  return <p>{title}</p>;
}
const ProtectedRoute = withAdvancedMode(ProtectedScreen);
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe("direct entry to Advanced-mode routes", () => {
  it("mounts protected queries only after Simple Mode is turned off", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.simple = true;
    state.queriesStarted = 0;
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(<ProtectedRoute title="Review controls" />));
    expect(state.queriesStarted).toBe(0);
    expect(container.textContent).toContain("Turn off Simple Mode");
    expect(container.textContent).not.toContain("Review controls");
    state.simple = false;
    act(() => root!.render(<ProtectedRoute title="Review controls" />));
    expect(state.queriesStarted).toBe(1);
    expect(container.textContent).toContain("Review controls");
  });
});
