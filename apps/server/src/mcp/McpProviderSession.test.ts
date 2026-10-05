import { describe, expect, it } from "vite-plus/test";
import { withAgentDeviceEnvironment, withAgentComputerEnvironment } from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("keeps Gmail vault keys and OAuth credentials out of provider subprocesses", () => {
    const base = {
      PATH: "/usr/bin",
      PROVIDER_KEY: "provider",
      DOER_GMAIL_ENCRYPTION_KEY: "vault",
      DOER_GOOGLE_OAUTH_CLIENT_SECRET: "oauth",
    };
    expect(withAgentComputerEnvironment(base, undefined)).toEqual({
      PATH: "/usr/bin",
      PROVIDER_KEY: "provider",
    });
    expect(base.DOER_GMAIL_ENCRYPTION_KEY).toBe("vault");
  });
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});
