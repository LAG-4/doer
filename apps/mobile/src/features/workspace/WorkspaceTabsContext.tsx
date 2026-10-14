import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import { useSimpleModeEnabled } from "../threads/use-simple-mode-enabled";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  type WorkspaceTab,
  type WorkspaceTabsAction,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";

export interface WorkspaceScrollAnchor {
  readonly key: string;
  readonly viewOffset: number;
}

export const WorkspaceTabsContext = createContext<{
  readonly state: WorkspaceTabsState;
  readonly availableTabs: ReadonlyArray<WorkspaceTab>;
  readonly dispatch: Dispatch<WorkspaceTabsAction>;
  readonly isTabActive: (tab: WorkspaceTab) => boolean;
  readonly bottomClearance: number;
  readonly getScrollOffset: (tab: WorkspaceTab) => number;
  readonly recordScrollOffset: (tab: WorkspaceTab, offset: number) => void;
  readonly getScrollAnchor: (tab: WorkspaceTab) => WorkspaceScrollAnchor | undefined;
  readonly recordScrollAnchor: (tab: WorkspaceTab, anchor: WorkspaceScrollAnchor) => void;
} | null>(null);

export function useWorkspaceTabs() {
  return use(WorkspaceTabsContext);
}

const SIMPLE_TABS = ["threads"] as const;
const ADVANCED_TABS = ["threads", "pullRequests"] as const;

/** The tab controller and its list screens share state across native container changes. */
export function WorkspaceTabsProvider(props: { readonly children: ReactNode }) {
  const simple = useSimpleModeEnabled();
  const [storedState, reduce] = useReducer(workspaceTabsReducer, undefined, initialWorkspaceTabsState);
  const state = useMemo(
    () =>
      simple && storedState.selectedTab !== "threads"
        ? { ...storedState, selectedTab: "threads" as const }
        : storedState,
    [simple, storedState],
  );
  useLayoutEffect(() => {
    if (simple && storedState.selectedTab !== "threads") reduce({ type: "select", tab: "threads" });
  }, [simple, storedState.selectedTab]);
  const dispatch = useCallback(
    (action: WorkspaceTabsAction) => {
      if (simple && action.tab === "pullRequests") return;
      reduce(action);
    },
    [simple],
  );
  const availableTabs = simple ? SIMPLE_TABS : ADVANCED_TABS;
  const activeTab = useRef(state.selectedTab);
  useLayoutEffect(() => {
    activeTab.current = state.selectedTab;
  }, [state.selectedTab]);
  const isTabActive = useCallback((tab: WorkspaceTab) => activeTab.current === tab, []);
  const scrollOffsets = useRef({ threads: 0, pullRequests: 0 });
  const scrollAnchors = useRef<Partial<Record<WorkspaceTab, WorkspaceScrollAnchor>>>({});
  const getScrollOffset = useCallback((tab: WorkspaceTab) => scrollOffsets.current[tab], []);
  const recordScrollOffset = useCallback((tab: WorkspaceTab, offset: number) => {
    scrollOffsets.current[tab] = offset;
  }, []);
  const getScrollAnchor = useCallback((tab: WorkspaceTab) => scrollAnchors.current[tab], []);
  const recordScrollAnchor = useCallback((tab: WorkspaceTab, anchor: WorkspaceScrollAnchor) => {
    scrollAnchors.current[tab] = anchor;
  }, []);
  const context = useMemo(
    () => ({
      state,
      availableTabs,
      dispatch,
      isTabActive,
      bottomClearance: 0,
      getScrollOffset,
      recordScrollOffset,
      getScrollAnchor,
      recordScrollAnchor,
    }),
    [
      state,
      availableTabs,
      dispatch,
      isTabActive,
      getScrollOffset,
      recordScrollOffset,
      getScrollAnchor,
      recordScrollAnchor,
    ],
  );
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>;
}
