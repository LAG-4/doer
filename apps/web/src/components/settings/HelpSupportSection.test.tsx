// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { HelpSupportSection } from "./HelpSupportSection";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function copyButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Copy summary"),
  );
  if (!found) throw new Error("Copy summary button was not rendered");
  return found as HTMLButtonElement;
}

function status(): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

it("links to fork issues, shows safe summary fields, and sends nothing by itself", async () => {
  await act(async () => {
    root.render(<HelpSupportSection connection="Connected (1 computer)" />);
  });
  const link = container.querySelector('a[href="https://github.com/LAG-4/doer/issues"]');
  expect(link).not.toBeNull();
  expect(container.textContent).not.toContain("discord");
  const preview = container.querySelector("pre")?.textContent ?? "";
  expect(preview).toContain("Doer support summary");
  expect(preview).toContain("Connected (1 computer)");
  expect(status()).toBe("");
});

it("announces copy success without any external transmission", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () => {
    root.render(<HelpSupportSection connection="Not connected" />);
  });
  await act(async () => copyButton().click());
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0]?.[0]).toContain("Doer support summary");
  expect(status()).toContain("nothing was sent automatically");
});

it("announces copy failure accessibly", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () => {
    root.render(<HelpSupportSection />);
  });
  await act(async () => copyButton().click());
  expect(status()).toContain("Copy failed");
});
