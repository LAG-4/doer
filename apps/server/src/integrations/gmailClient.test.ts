import { describe, expect, it } from "vite-plus/test";

import {
  createGmailOAuthAttempt,
  encodeGmailMessage,
  exchangeGmailCode,
  refreshGmailToken,
  sendGmailMessage,
  revokeGmailToken,
  GMAIL_SEND_SCOPE,
} from "./gmailClient.ts";

describe("Gmail connector request boundaries", () => {
  it("records granted scopes and keeps a rotated refresh token", async () => {
    const request = (async () =>
      Response.json({
        access_token: "a",
        refresh_token: "rotated",
        expires_in: 3600,
        scope: `openid email ${GMAIL_SEND_SCOPE}`,
      })) as typeof fetch;
    const tokens = await refreshGmailToken("client", "secret", "old", request, 0);
    expect(tokens.refreshToken).toBe("rotated");
    expect(tokens.scopes).toContain(GMAIL_SEND_SCOPE);
  });
  it("revokes with a POST body and treats already revoked credentials as disconnected", async () => {
    const request = (async (url, init) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/revoke");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      expect((init!.body as URLSearchParams).get("token")).toBe("refresh");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await revokeGmailToken("refresh", request);
    await revokeGmailToken("refresh", (async () =>
      Response.json({ error: "invalid_token" }, { status: 400 })) as typeof fetch);
    await expect(
      revokeGmailToken(
        "refresh",
        (async () => new Response(null, { status: 503 })) as typeof fetch,
      ),
    ).rejects.toThrow("could not be revoked");
  });
  it("rejects extra recipients hidden inside one address", () => {
    expect(() =>
      encodeGmailMessage({ to: ["a@example.com,b@example.com"], subject: "HI", body: "Test" }),
    ).toThrow("Invalid recipient");
  });
  it("starts a send-only PKCE authorization without granting mailbox read access", () => {
    const attempt = createGmailOAuthAttempt("client", "http://127.0.0.1:9000/callback");
    const url = new URL(attempt.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/gmail.send",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(attempt.verifier).not.toBe(url.searchParams.get("code_challenge"));
    expect(url.searchParams.get("state")).toBe(attempt.state);
    expect(attempt.state).not.toBe(
      createGmailOAuthAttempt("client", "http://127.0.0.1:9000/callback").state,
    );
  });

  it("exchanges and refreshes a token without returning Google errors or tokens in exceptions", async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as URLSearchParams });
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }) as typeof fetch;
    const exchanged = await exchangeGmailCode(
      {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://127.0.0.1/callback",
        code: "code",
        verifier: "verifier",
      },
      request,
      1000,
    );
    expect(exchanged).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 3601000,
      scopes: [],
    });
    expect(calls[0]?.body.get("code_verifier")).toBe("verifier");
    expect(calls[0]?.body.get("client_secret")).toBe("secret");
    const refreshed = await refreshGmailToken("client", "secret", "refresh", request, 2000);
    expect(refreshed.refreshToken).toBe("refresh");
    expect(calls[1]?.body.get("grant_type")).toBe("refresh_token");
    expect(calls[1]?.body.get("client_secret")).toBe("secret");
  });

  it("reports a Google token error code without exposing its response details", async () => {
    const request = (async () =>
      Response.json(
        { error: "invalid_client", error_description: "private-token-value" },
        { status: 400 },
      )) as typeof fetch;
    await expect(
      exchangeGmailCode(
        {
          clientId: "client",
          clientSecret: "secret",
          redirectUri: "http://127.0.0.1/callback",
          code: "code",
          verifier: "verifier",
        },
        request,
      ),
    ).rejects.toThrow("Google token request failed (400, invalid_client).");
  });

  it("blocks header injection and sends UTF-8 mail as Gmail MIME", async () => {
    expect(() =>
      encodeGmailMessage({ to: ["a@example.com\r\nBcc: x@example.com"], subject: "hi", body: "" }),
    ).toThrow();
    let raw = "";
    const request = (async (_url: string | URL | Request, init?: RequestInit) => {
      raw = (JSON.parse(String(init?.body)) as { raw: string }).raw;
      return Response.json({ id: "message-id", threadId: "thread-id" });
    }) as typeof fetch;
    await expect(
      sendGmailMessage(
        "token",
        { to: ["a@example.com"], subject: "Résumé", body: "Hello ✓" },
        request,
      ),
    ).resolves.toEqual({ id: "message-id", threadId: "thread-id" });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: a@example.com");
    expect(mime).toContain(Buffer.from("Hello ✓").toString("base64"));
  });
});
