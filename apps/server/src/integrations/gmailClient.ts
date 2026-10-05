// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Google boundary uses Node encoding and an injectable clock.
import * as NodeCrypto from "node:crypto";

/** Gmail's send-only scope avoids mailbox read access. Drafts require gmail.compose. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface GmailOAuthAttempt {
  readonly state: string;
  readonly verifier: string;
  readonly authorizationUrl: string;
}

export interface GmailTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

export interface GmailMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

export function createGmailOAuthAttempt(clientId: string, redirectUri: string): GmailOAuthAttempt {
  const state = NodeCrypto.randomBytes(32).toString("base64url");
  const verifier = NodeCrypto.randomBytes(32).toString("base64url");
  const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `openid email ${GMAIL_SEND_SCOPE}`);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { state, verifier, authorizationUrl: url.toString() };
}

async function readTokenResponse(response: Response, now: number): Promise<GmailTokens> {
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const code =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string" &&
      /^[a-z_]+$/.test(value.error)
        ? value.error
        : "unknown_error";
    throw new Error(`Google token request failed (${response.status}, ${code}).`);
  }
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid Google token response.");
  const token = value as Record<string, unknown>;
  if (
    typeof token.access_token !== "string" ||
    token.access_token.length === 0 ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new Error("Invalid Google token response.");
  }
  return {
    accessToken: token.access_token,
    ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
    expiresAt: now + token.expires_in * 1000,
    scopes: typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : [],
  };
}

export async function exchangeGmailCode(
  input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    verifier: string;
  },
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<GmailTokens> {
  const response = await request(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  return readTokenResponse(response, now);
}

export async function refreshGmailToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<GmailTokens> {
  const response = await request(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokens = await readTokenResponse(response, now);
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/** Revoking a refresh token also revokes the access tokens belonging to its grant. */
export async function revokeGmailToken(
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const response = await request(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return;
  const value: unknown = await response.json().catch(() => null);
  if (
    response.status === 400 &&
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "invalid_token"
  )
    return;
  throw new Error("Google access could not be revoked. Try Disconnect again.");
}

export async function readGmailAccount(
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<string> {
  const response = await request("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Google account request failed (${response.status}).`);
  const value: unknown = await response.json();
  const email =
    typeof value === "object" && value !== null && "email" in value ? value.email : null;
  if (typeof email !== "string" || email.length === 0)
    throw new Error("Google did not return an email address.");
  return email;
}

function safeHeader(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Mail headers cannot contain line breaks.");
  return value.trim();
}

export function encodeGmailMessage(message: GmailMessage): string {
  if (
    message.to.length === 0 ||
    message.to.length > 20 ||
    message.body.length > 50_000 ||
    message.subject.length > 998
  )
    throw new Error(
      "Email must have 1–20 recipients, a subject under 999 characters, and a body under 50,001 characters.",
    );
  const recipients = message.to.map((recipient) => {
    const address = safeHeader(recipient);
    if (!/^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/.test(address)) {
      throw new Error("Invalid recipient address.");
    }
    return address;
  });
  const subject = safeHeader(message.subject);
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const mime = [
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(message.body, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

export async function sendGmailMessage(
  accessToken: string,
  message: GmailMessage,
  request: typeof fetch = fetch,
): Promise<{ id: string; threadId?: string }> {
  const response = await request(GMAIL_SEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: encodeGmailMessage(message) }),
    // Sending is not retried: a lost response may already have delivered the email.
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Gmail send failed (${response.status}).`);
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("Invalid Gmail send response.");
  }
  const threadId =
    "threadId" in value && typeof value.threadId === "string" ? value.threadId : undefined;
  return { id: value.id, ...(threadId ? { threadId } : {}) };
}
