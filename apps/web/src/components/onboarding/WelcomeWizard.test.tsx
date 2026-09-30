// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  toast: vi.fn(),
  close: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: mocks.close, update: mocks.update },
}));
import { WelcomeWizard } from "./WelcomeWizard";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.complete.mockResolvedValue(undefined);
  mocks.toast.mockReturnValue("completion-error");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}
it("completes the tour after all three slides", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Back");
  await click("Continue");
  await click("Continue");
  expect(mocks.complete).not.toHaveBeenCalled();
  await click("Start using Doer");
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.toast).not.toHaveBeenCalled();
});
it("allows skipping the tour", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Not Now");
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledOnce();
});
it("keeps the tour open when saving fails and allows a retry", async () => {
  mocks.complete.mockRejectedValueOnce(new Error("save failed"));
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Not Now");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish the tour" }),
  );
  await click("Not Now");
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.complete).toHaveBeenCalledTimes(2);
  expect(mocks.close).toHaveBeenCalledWith("completion-error");
});
