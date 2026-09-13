import { describe, expect, it } from "vite-plus/test";
import {
  buildRuntimeInstructions,
  buildT3ToolInstructions,
  t3ToolAvailabilityFromCapabilities,
} from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("omits tool blocks when no t3-code server is attached", () => {
    const instructions = buildRuntimeInstructions({ harness: "OpenCode" });
    expect(instructions).not.toContain("## Doer tools");
    expect(instructions).not.toContain("computer_*");
  });
});

describe("t3ToolAvailabilityFromCapabilities", () => {
  it("maps preview/device/computer capabilities", () => {
    expect(t3ToolAvailabilityFromCapabilities(new Set(["preview", "device", "computer"]))).toEqual({
      browser: true,
      device: true,
      computer: true,
    });
    expect(t3ToolAvailabilityFromCapabilities(new Set(["preview"]))).toEqual({
      browser: true,
      device: false,
      computer: false,
    });
    expect(t3ToolAvailabilityFromCapabilities(undefined)).toEqual({
      browser: false,
      device: false,
      computer: false,
    });
  });
});

describe("buildT3ToolInstructions", () => {
  it("describes only the attached families plus routing when both are present", () => {
    const full = buildT3ToolInstructions({ browser: true, device: true, computer: true });
    expect(full).toContain("preview_*");
    expect(full).toContain("device_*");
    expect(full).toContain("computer_*");
    expect(full).toContain("Choosing between the browser and computer use");
    expect(full).toContain("announce briefly before driving");

    const computerOnly = buildT3ToolInstructions({ browser: false, device: false, computer: true });
    expect(computerOnly).toContain("computer_*");
    expect(computerOnly).not.toContain("preview_*");
    expect(computerOnly).not.toContain("Choosing between");

    expect(buildT3ToolInstructions({ browser: false, device: false, computer: false })).toBe("");
  });

  it("attaches the briefing to runtime instructions when tools are present", () => {
    const instructions = buildRuntimeInstructions({
      harness: "OpenCode",
      t3Tools: { browser: true, device: false, computer: true },
    });
    expect(instructions).toContain("## Doer tools");
    expect(instructions).toContain("computer-use");
  });
});
