// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  installation: null as ProviderInstallState | null,
  start: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerInstallState: () => "install-state",
    startProviderInstall: "start",
    cancelProviderInstall: "cancel",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.installation, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "start" ? mocks.start : mocks.cancel),
}));

import { CliSetupSection } from "./CliSetupSection";

const environmentId = EnvironmentId.make("friends-computer");
const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const provider: ServerProvider = {
  instanceId,
  driver,
  installed: false,
  enabled: false,
  version: null,
  status: "disabled",
  auth: { status: "unknown" },
  checkedAt: "2026-10-01T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canInstall: true, canAuthenticate: false },
};
const idle: ProviderInstallState = {
  driver,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  message: null,
  canRemove: false,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.installation = idle;
  mocks.start.mockResolvedValue({ _tag: "Success", value: idle });
  mocks.cancel.mockResolvedValue({ _tag: "Success", value: idle });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(readOnly = false) {
  await act(async () =>
    root.render(
      <CliSetupSection
        environmentId={environmentId}
        environmentLabel="Friend’s computer"
        instanceId={instanceId}
        provider={provider}
        displayName="Claude"
        enabled={false}
        readOnly={readOnly}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  expect(found, label).toBeDefined();
  return found!;
}

it("keeps failed remote setup actionable and shows verified installation", async () => {
  await render();
  expect(container.textContent).toContain("Friend’s computer");
  await act(async () => button("Install and enable Claude").click());
  expect(mocks.start).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  mocks.installation = {
    ...idle,
    operationId: "attempt-1",
    phase: "failed",
    message: "Check your internet connection and try again.",
  };
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Check your internet connection",
  );
  await act(async () => button("Try setup again").click());
  expect(mocks.start).toHaveBeenCalledTimes(2);
  mocks.installation = {
    ...idle,
    operationId: "attempt-2",
    phase: "downloading",
    message: "Installing.",
  };
  await render();
  expect(container.textContent).toContain("Installing.");
  await act(async () => button("Cancel setup").click());
  expect(mocks.cancel).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, operationId: "attempt-2" },
  });
  mocks.installation = { ...idle, phase: "succeeded", installedVersion: "2.1.198" };
  await render();
  expect(container.textContent).toContain("Installed on Friend’s computer");
  expect(container.textContent).toContain("Connect your account");
});

it("prevents installation from a read-only connection", async () => {
  await render(true);
  expect(button("Install and enable Claude").disabled).toBe(true);
  await act(async () => button("Install and enable Claude").click());
  expect(mocks.start).not.toHaveBeenCalled();
});
