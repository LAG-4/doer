import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { OpenCodeSettings } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);

describe("OpenCode defaults", () => {
  const driver = ProviderDriverKind.make("opencode");

  it("enables the free model for ordinary tasks and text generation on a fresh install", () => {
    expect(decodeSettings({}).enabled).toBe(true);
    expect(DEFAULT_MODEL_BY_PROVIDER[driver]).toBe("opencode/big-pickle");
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver]).toBe("opencode/big-pickle");
  });

  it("preserves explicit legacy opt-outs and their custom configuration", () => {
    const settings = decodeSettings({
      enabled: false,
      binaryPath: "/custom/opencode",
      customModels: ["openai/gpt-5"],
    });
    expect(settings.enabled).toBe(false);
    expect(settings.binaryPath).toBe("/custom/opencode");
    expect(settings.customModels).toEqual(["openai/gpt-5"]);
    expect(resolveProviderInstanceEnabled({ driver, enabled: true, config: settings })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver, enabled: false, config: {} })).toBe(false);
  });
});
