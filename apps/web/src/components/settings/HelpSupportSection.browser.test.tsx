import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../test/render";
import { HelpSupportSection } from "./HelpSupportSection";

function status(screen: Screen): string {
  return screen.container.querySelector('[role="status"]')?.textContent ?? "";
}

describe("HelpSupportSection", () => {
  it("links to fork issues, shows safe summary fields, and sends nothing by itself", async () => {
    await using screen = await render(<HelpSupportSection connection="Connected (1 computer)" />);
    const link = screen.container.querySelector('a[href="https://github.com/LAG-4/doer/issues"]');
    expect(link).not.toBeNull();
    expect(screen.container.textContent).not.toContain("discord");
    const preview = screen.container.querySelector("pre")?.textContent ?? "";
    expect(preview).toContain("Doer support summary");
    expect(preview).toContain("Connected (1 computer)");
    expect(status(screen)).toBe("");
  });

  it("announces copy success without any external transmission", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await using screen = await render(<HelpSupportSection connection="Not connected" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain("Doer support summary");
    expect(status(screen)).toContain("nothing was sent automatically");
  });

  it("announces copy failure accessibly", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await using screen = await render(<HelpSupportSection />);
    await userEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(status(screen)).toContain("Copy failed");
  });
});
