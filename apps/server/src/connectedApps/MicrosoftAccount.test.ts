import { describe, expect, it } from "vite-plus/test";
import { MicrosoftAccount } from "./MicrosoftAccount.ts";
import { connectedSourcePath } from "../mcp/toolkits/connectedApps/handlers.ts";
function fixture(responses: Response[], clientId = "registered-test-client") {
  const secrets = new Map<string, Uint8Array>();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let now = 0;
  const connection = new MicrosoftAccount({
    clientId,
    now: () => now,
    storage: {
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, bytes) => {
        secrets.set(name, bytes);
      },
      remove: async (name) => {
        secrets.delete(name);
      },
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Microsoft request");
      return response;
    },
  });
  return {
    connection,
    calls,
    secrets,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
const device = () =>
  Response.json({
    device_code: "private-device-code",
    user_code: "USER-CODE",
    verification_uri: "https://microsoft.com/devicelogin",
    expires_in: 900,
    interval: 5,
  });
const token = () =>
  Response.json({
    access_token: "private-access",
    refresh_token: "private-refresh",
    expires_in: 3600,
  });
describe("Microsoft connection", () => {
  it("shows an honest unavailable state without an operator app id", async () => {
    const f = fixture([], "");
    expect(await f.connection.status()).toMatchObject({ configured: false, connected: false });
    await expect(f.connection.start(false)).rejects.toThrow(/not configured/);
    expect(f.calls).toHaveLength(0);
  });
  it("honors polling intervals, persists tokens privately and disconnects", async () => {
    const f = fixture([
      device(),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      token(),
      Response.json({ displayName: "Test User" }),
    ]);
    const signIn = await f.connection.start(false);
    expect(JSON.stringify(signIn)).not.toContain("private-device-code");
    expect(await f.connection.finish()).toHaveProperty("waiting");
    expect(f.calls).toHaveLength(1);
    f.advance(5000);
    expect(await f.connection.finish()).toHaveProperty("waiting");
    f.advance(5000);
    expect(await f.connection.finish()).toMatchObject({
      status: { connected: true, account: "Test User", sharePoint: false },
    });
    expect(f.secrets.size).toBe(1);
    expect(JSON.stringify(await f.connection.status())).not.toContain("private-access");
    expect(String(f.calls[0]?.init?.body)).not.toContain("Sites.Read.All");
    expect(await f.connection.disconnect()).toMatchObject({ connected: false });
    expect(f.secrets.size).toBe(0);
  });
  it("explains administrator consent and expiry without claiming a connection", async () => {
    const f = fixture([device(), Response.json({ error: "access_denied" }, { status: 400 })]);
    await f.connection.start(true);
    f.advance(5000);
    await expect(f.connection.finish()).rejects.toThrow(/administrator/);
    expect(await f.connection.status()).toMatchObject({ connected: false });
    expect(String(f.calls[0]?.init?.body)).toContain("Sites.Read.All");
    await expect(f.connection.finish()).rejects.toThrow(/expired or was cancelled/);
  });
  it("blocks SharePoint without opt-in and explains reauthentication", async () => {
    const f = fixture([
      device(),
      token(),
      Response.json({ displayName: "Test User" }),
      Response.json({}, { status: 401 }),
    ]);
    await f.connection.start(false);
    f.advance(5000);
    await f.connection.finish();
    await expect(f.connection.graph("/sites?search=reports")).rejects.toThrow(
      /SharePoint access is off/,
    );
    await expect(f.connection.graph("/me/messages?$top=1")).rejects.toThrow(/reconnect/);
  });
  it("downloads selected files without forwarding the account token to signed storage", async () => {
    const f = fixture([
      device(),
      token(),
      Response.json({ displayName: "Test User" }),
      new Response(null, {
        status: 302,
        headers: { location: "https://tenant.sharepoint.com/file" },
      }),
      new Response(new Uint8Array([1, 2, 3])),
    ]);
    await f.connection.start(false);
    f.advance(5000);
    await f.connection.finish();
    expect(await f.connection.downloadFile("selected-file")).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.calls.at(-1)?.init?.headers).toBeUndefined();
  });
});
describe("connected source selection", () => {
  it("requires a bounded calendar range with explicit timezone and preserves query data", () => {
    expect(() =>
      connectedSourcePath({ action: "calendar", start: "2026-10-01", end: "2026-10-02" }),
    ).toThrow(/timezone/);
    expect(
      connectedSourcePath({
        action: "calendar",
        start: "2026-10-01T09:00:00+05:30",
        end: "2026-10-02T09:00:00+05:30",
      }),
    ).toContain("calendarView?");
    expect(connectedSourcePath({ action: "read-email", id: "one/other?" })).toContain(
      "one%2Fother%3F",
    );
    expect(() => connectedSourcePath({ action: "search-files" })).toThrow(/what you want to find/);
  });
});
