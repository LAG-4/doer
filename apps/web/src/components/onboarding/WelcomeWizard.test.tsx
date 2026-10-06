// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  submit: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  prepareInbox: vi.fn(),
  settleInbox: vi.fn(),
  providers: [] as Array<Record<string, unknown>>,
  config: null as Record<string, unknown> | null,
  welcome: null as Record<string, unknown> | null,
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
  inboxCapable: true,
  thread: null as Record<string, unknown> | null,
  threadStatus: "empty" as string,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "refresh" ? mocks.refresh : mocks.refresh),
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../../onboarding/firstTaskSubmit", () => ({ submitFirstTask: mocks.submit }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
  useServerConfigs: () => new Map(),
  useThread: () => mocks.thread,
  useThreadStatus: () => mocks.threadStatus,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "env-1", label: "Computer" }),
}));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: "providers-atom",
  primaryServerConfigAtom: "config-atom",
  primaryServerWelcomeAtom: "welcome-atom",
  serverEnvironment: { refreshProviders: "refresh" },
}));
vi.mock("../../hooks/useEnsureInboxProject", () => ({
  useEnsureInboxProject: () => ({
    prepareInboxProject: mocks.prepareInbox,
    settleInboxProject: mocks.settleInbox,
    isInboxCapable: mocks.inboxCapable,
  }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => {
    if (atom === "providers-atom") return mocks.providers;
    if (atom === "config-atom") return mocks.config;
    if (atom === "welcome-atom") return mocks.welcome;
    return null;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

const READY_OPENCODE = {
  instanceId: "opencode",
  driver: "opencode",
  displayName: "OpenCode",
  enabled: true,
  installed: true,
  status: "ready",
  availability: "available",
  auth: { status: "authenticated" },
  models: [
    {
      slug: "opencode/big-pickle",
      name: "Big Pickle",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
};

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
  mocks.providers = [{ ...READY_OPENCODE }];
  mocks.config = { settings: {} };
  mocks.welcome = { inboxProjectId: "inbox-1", inboxWorkspaceRoot: "/inbox" };
  mocks.projects = [{ id: "inbox-1", environmentId: "env-1", workspaceRoot: "/inbox" }];
  mocks.inboxCapable = true;
  mocks.thread = null;
  mocks.threadStatus = "empty";
  mocks.complete.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue({});
  mocks.navigate.mockResolvedValue(undefined);
  mocks.prepareInbox.mockReturnValue({
    ref: { environmentId: "env-1", projectId: "inbox-1" },
    projectId: "inbox-1",
    isNew: false,
  });
  mocks.settleInbox.mockResolvedValue({ environmentId: "env-1", projectId: "inbox-1" });
  mocks.submit.mockResolvedValue({ environmentId: "env-1", threadId: "thread-1" });
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
    (element) => element.textContent?.includes(label) ?? false,
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

it("opens with the first-task choice and no technical setup", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  expect(text()).toContain("Let’s try something useful.");
  expect(text()).toContain("Doer will explain the important points");
  expect(button("Use my document")).toBeDefined();
  expect(button("Try a sample")).toBeDefined();
  expect(button("Skip for now")).toBeDefined();
  expect(text()).toContain("No accounts to connect");
});

it("runs the sample task end to end through the real submit path", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Try a sample");
  expect(text()).toContain("Here’s what happens next.");
  expect(text()).toContain("sample-sales-report.md");
  expect(text()).toContain("Sample report — fictional data.");
  expect(text()).toContain("Your free AI is ready");
  await click("Explain this report");
  expect(mocks.submit).toHaveBeenCalledOnce();
  const input = mocks.submit.mock.calls[0]![0] as {
    prompt: string;
    file: File;
    modelSelection: { instanceId: string; model: string };
  };
  expect(input.file.name).toBe("sample-sales-report.md");
  expect(input.prompt).toContain("sample-sales-report.md");
  expect(input.prompt).toContain("improved or declined");
  expect(input.modelSelection).toEqual({ instanceId: "opencode", model: "opencode/big-pickle" });
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "env-1", threadId: "thread-1" },
    replace: true,
  });
  expect(onDone).toHaveBeenCalledOnce();
  expect(JSON.parse(window.localStorage.getItem("doer.first-task.v1")!)).toMatchObject({
    status: "pending",
    thread: { environmentId: "env-1", threadId: "thread-1" },
  });
});

it("prevents duplicate tasks from repeated clicks", async () => {
  let release!: () => void;
  mocks.submit.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () => resolve({ environmentId: "env-1", threadId: "thread-1" });
    }),
  );
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Try a sample");
  // Both clicks land in a single act() pass: the submitting guard drops the
  // second, and separate act() calls must never overlap (React warns and
  // discards queued work, which wedges every later render in this file).
  await act(async () => {
    button("Explain this report").click();
    button("Explain this report").click();
  });
  await act(async () => {
    release();
  });
  expect(mocks.submit).toHaveBeenCalledOnce();
});

it("keeps inputs and shows recovery when starting fails", async () => {
  mocks.submit.mockRejectedValueOnce(new Error("Computer is offline"));
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Try a sample");
  await click("Explain this report");
  expect(text()).toContain("Computer is offline");
  expect(text()).toContain("sample-sales-report.md");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("shows setup progress truthfully while the free provider installs", async () => {
  mocks.providers = [];
  mocks.config = null;
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Try a sample");
  expect(text()).toContain("Getting your free AI ready…");
  expect(button("Explain this report").disabled).toBe(true);
  expect(onDone).not.toHaveBeenCalled();
});

it("shows provider failures with a retry that re-probes", async () => {
  mocks.providers = [
    {
      ...READY_OPENCODE,
      status: "error",
      message: "Probe failed",
    },
  ];
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Try a sample");
  expect(text()).toContain("Probe failed");
  expect(button("Explain this report").disabled).toBe(true);
  await click("Try again");
  expect(mocks.refresh).toHaveBeenCalledWith({ environmentId: "env-1", input: {} });
  expect(onDone).not.toHaveBeenCalled();
});

it("recovers from a failed fresh install before allowing the first task", async () => {
  const installFailure =
    "Could not download the free AI service. Check your internet connection and try setup again.";
  mocks.providers = [
    {
      ...READY_OPENCODE,
      installed: false,
      status: "error",
      availability: "unavailable",
      models: [],
      message: installFailure,
    },
  ];
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Try a sample");
  expect(text()).toContain(installFailure);
  expect(text()).not.toContain("Getting the AI service ready…");
  expect(button("Explain this report").disabled).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
  await click("Try again");
  expect(mocks.refresh).toHaveBeenCalledWith({ environmentId: "env-1", input: {} });
  mocks.providers = [READY_OPENCODE];
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  expect(text()).toContain("Your free AI is ready");
  expect(text()).toContain("sample-sales-report.md");
  await click("Explain this report");
  expect(mocks.submit).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledOnce();
});

it("pauses instead of silently switching to a paid provider", async () => {
  mocks.providers = [
    { ...READY_OPENCODE, status: "error" },
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
      auth: { status: "authenticated" },
      models: [{ slug: "claude-opus", name: "Opus", isCustom: false, capabilities: null }],
    },
  ];
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Try a sample");
  expect(text()).toContain("won’t switch you to a paid service");
  expect(button("Explain this report").disabled).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("pauses when a ready OpenCode account has no free models", async () => {
  mocks.providers = [
    {
      ...READY_OPENCODE,
      models: [{ ...READY_OPENCODE.models[0]!, slug: "paid-model", name: "Paid model" }],
    },
  ];
  await act(async () => root.render(<WelcomeWizard onDone={vi.fn()} />));
  await click("Try a sample");
  expect(text()).toContain("No free model is available");
  expect(text()).not.toContain("Your free AI is ready");
  expect(button("Explain this report").disabled).toBe(true);
  expect(button("Choose an AI service")).toBeDefined();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("records a skip distinctly from first-task success", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Skip for now");
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledOnce();
  expect(JSON.parse(window.localStorage.getItem("doer.first-task.v1")!)).toMatchObject({
    status: "skipped",
    thread: null,
  });
});

it("offers the way back to a pending task instead of duplicating it", async () => {
  window.localStorage.setItem(
    "doer.first-task.v1",
    JSON.stringify({
      status: "pending",
      thread: { environmentId: "env-1", threadId: "thread-1" },
      fileName: "report.pdf",
      followUpDismissed: false,
      startedAt: "2026-09-30T00:00:00.000Z",
      completedAt: null,
    }),
  );
  mocks.thread = { id: "thread-1" };
  mocks.threadStatus = "live";
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  expect(text()).toContain("Your report task is still running.");
  await click("View my task");
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "env-1", threadId: "thread-1" },
    replace: true,
  });
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("skips with Escape", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  const popup = document.querySelector('[aria-label="Welcome to Doer"]')!;
  await act(async () => {
    popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.complete).toHaveBeenCalledOnce();
});
