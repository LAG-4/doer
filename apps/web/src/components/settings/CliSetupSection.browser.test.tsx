import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  installation: null as ProviderInstallState | null,
  start: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original()),
  serverEnvironment: {
    providerInstallState: () => "install-state",
    startProviderInstall: "start",
    cancelProviderInstall: "cancel",
  },
}));
vi.mock("../../state/query", async (original) => ({
  ...(await original()),
  useEnvironmentQuery: () => ({ data: mocks.installation, error: null }),
}));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original()),
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

function setup() {
  vi.clearAllMocks();
  mocks.installation = idle;
  mocks.start.mockResolvedValue({ _tag: "Success", value: idle });
  mocks.cancel.mockResolvedValue({ _tag: "Success", value: idle });
}

function section(readOnly = false) {
  return (
    <CliSetupSection
      environmentId={environmentId}
      environmentLabel="Friend’s computer"
      instanceId={instanceId}
      provider={provider}
      displayName="Claude"
      enabled={false}
      readOnly={readOnly}
    />
  );
}

async function renderSection(readOnly = false) {
  const screen = await render(section(readOnly));
  const button = (label: string) => {
    const found = [...screen.container.querySelectorAll("button")].find((element) =>
      element.textContent?.includes(label),
    );
    expect(found, label).toBeDefined();
    return found!;
  };
  return Object.assign(screen, {
    button,
    async click(label: string) {
      await act(async () => button(label).click());
    },
  });
}

describe("CliSetupSection", () => {
  it("keeps failed remote setup actionable and shows verified installation", async () => {
    setup();
    await using screen = await renderSection();
    expect(screen.container.textContent).toContain("Friend’s computer");
    await screen.click("Install and enable Claude");
    expect(mocks.start).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    mocks.installation = {
      ...idle,
      operationId: "attempt-1",
      phase: "failed",
      message: "Check your internet connection and try again.",
    };
    await screen.rerender(section());
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Check your internet connection",
    );
    await screen.click("Try setup again");
    expect(mocks.start).toHaveBeenCalledTimes(2);
    mocks.installation = {
      ...idle,
      operationId: "attempt-2",
      phase: "downloading",
      message: "Installing.",
    };
    await screen.rerender(section());
    expect(screen.container.textContent).toContain("Installing.");
    await screen.click("Cancel setup");
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, operationId: "attempt-2" },
    });
    mocks.installation = { ...idle, phase: "succeeded", installedVersion: "2.1.198" };
    await screen.rerender(section());
    expect(screen.container.textContent).toContain("Installed on Friend’s computer");
    expect(screen.container.textContent).toContain("Connect your account");
  });

  it("prevents installation from a read-only connection", async () => {
    setup();
    await using screen = await renderSection(true);
    expect(screen.button("Install and enable Claude").disabled).toBe(true);
    await screen.click("Install and enable Claude");
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
