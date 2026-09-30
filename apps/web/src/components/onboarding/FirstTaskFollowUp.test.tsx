// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  thread: null as Record<string, unknown> | null,
  threadStatus: "empty" as string,
}));

vi.mock("../../state/entities", () => ({
  useThread: () => mocks.thread,
  useThreadStatus: () => mocks.threadStatus,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: mocks.navigate }),
}));

import { readFirstTaskRecord, writeFirstTaskRecord } from "../../onboarding/firstTaskRecord";
import { FirstTaskFollowUp } from "./FirstTaskFollowUp";

const KEY = "doer.first-task.v1";
const EXPLANATION =
  "Sales rose 13.7% to $184,500, beating the $175,000 target. The Trail Backpack surged on an influencer mention while the Cozy Lamp slipped on faulty dimmers.";

function pendingRecord() {
  writeFirstTaskRecord({
    status: "pending",
    thread: { environmentId: "env-1", threadId: "thread-1" },
    fileName: "sample-sales-report.md",
    followUpDismissed: false,
    startedAt: "2026-09-30T00:00:00.000Z",
    completedAt: null,
  });
}

function completedThread() {
  return {
    id: "thread-1",
    deletedAt: null,
    latestTurn: { turnId: "t1", state: "completed", assistantMessageId: "m1" },
    session: { status: "ready" },
    messages: [{ role: "assistant", text: EXPLANATION, turnId: "t1" }],
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.navigate.mockResolvedValue(undefined);
  mocks.thread = null;
  mocks.threadStatus = "empty";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

function text(): string {
  return document.body.textContent ?? "";
}

it("stays quiet without a task or after a skip", async () => {
  await act(async () => root.render(<FirstTaskFollowUp />));
  expect(text()).toBe("");
  writeFirstTaskRecord({
    status: "skipped",
    thread: null,
    fileName: "",
    followUpDismissed: true,
    startedAt: "2026-09-30T00:00:00.000Z",
    completedAt: "2026-09-30T00:00:00.000Z",
  });
  await act(async () => root.render(<FirstTaskFollowUp />));
  expect(text()).toBe("");
});

it("records success and offers next steps when the result lands", async () => {
  pendingRecord();
  mocks.thread = completedThread();
  mocks.threadStatus = "live";
  await act(async () => root.render(<FirstTaskFollowUp />));
  await act(async () => {});
  expect(readFirstTaskRecord()).toMatchObject({ status: "succeeded" });
  expect(text()).toContain("Your explanation is ready.");
  expect(button("Ask about this report")).toBeDefined();
  expect(button("Try another task")).toBeDefined();
  expect(button("Go to my tasks")).toBeDefined();
  await click("Ask about this report");
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "env-1", threadId: "thread-1" },
  });
  expect(readFirstTaskRecord()).toMatchObject({ followUpDismissed: true });
  expect(text()).toBe("");
});

it("routes the other success actions without losing the task", async () => {
  pendingRecord();
  mocks.thread = completedThread();
  mocks.threadStatus = "live";
  await act(async () => root.render(<FirstTaskFollowUp />));
  await act(async () => {});
  await click("Try another task");
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/welcome" });
});

it("explains terminal failures and points back at the task", async () => {
  pendingRecord();
  mocks.thread = {
    ...completedThread(),
    latestTurn: { turnId: "t1", state: "error", assistantMessageId: null },
  };
  mocks.threadStatus = "live";
  await act(async () => root.render(<FirstTaskFollowUp />));
  await act(async () => {});
  expect(text()).toContain("That didn’t work.");
  expect(readFirstTaskRecord()).toMatchObject({ status: "pending" });
  await click("Open the task");
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "env-1", threadId: "thread-1" },
  });
});
