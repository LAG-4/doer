// @effect-diagnostics globalDate:off
import * as Schema from "effect/Schema";
import type { MicrosoftSignIn, MicrosoftStatus } from "@t3tools/shared/microsoftConnection";

const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
});
const SavedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  account: Schema.String,
  sharePoint: Schema.Boolean,
});
const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});
const OAuthError = Schema.Struct({ error: Schema.String });
export const GraphItems = Schema.Struct({ value: Schema.Array(Schema.Unknown) });
export class MicrosoftAccountError extends Error {
  readonly _tag = "MicrosoftAccountError";
}
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value);
const SECRET_NAME = "doer-microsoft-account";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/** A single account per computer. Tokens stay in the host's protected secret store. */
export class MicrosoftAccount {
  private pending: {
    code: string;
    expiresAt: number;
    nextPoll: number;
    interval: number;
    sharePoint: boolean;
    generation: number;
  } | null = null;
  private generation = 0;
  private refresh: Promise<typeof SavedToken.Type> | null = null;
  private readonly dependencies: {
    clientId: string;
    storage: {
      get: (name: string) => Promise<Uint8Array | null>;
      set: (name: string, value: Uint8Array) => Promise<void>;
      remove: (name: string) => Promise<void>;
    };
    fetch: typeof fetch;
    now?: () => number;
  };
  constructor(dependencies: MicrosoftAccount["dependencies"]) {
    this.dependencies = dependencies;
  }
  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }
  private requireConfigured() {
    if (!this.dependencies.clientId)
      throw new MicrosoftAccountError(
        "Microsoft sign-in is not configured in this installation yet. You can still attach exported files to a Task.",
      );
  }
  private async saved() {
    const bytes = await this.dependencies.storage.get(SECRET_NAME);
    if (!bytes) return null;
    try {
      return decode(SavedToken, JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new MicrosoftAccountError(
        "Your saved Microsoft connection could not be read. Disconnect it and sign in again.",
      );
    }
  }
  async status(): Promise<MicrosoftStatus> {
    const saved = await this.saved();
    return {
      configured: !!this.dependencies.clientId,
      connected: saved !== null,
      account: saved?.account ?? null,
      sharePoint: saved?.sharePoint ?? false,
    };
  }
  private async request(url: string, init: RequestInit) {
    try {
      return await this.dependencies.fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new MicrosoftAccountError(
        "Could not reach Microsoft. Check this computer's internet connection and try again; your work is kept.",
      );
    }
  }
  async start(sharePoint: boolean): Promise<MicrosoftSignIn> {
    this.requireConfigured();
    const generation = ++this.generation;
    this.pending = null;
    const scope = `offline_access User.Read Mail.Read Calendars.Read Files.Read${sharePoint ? " Sites.Read.All" : ""}`;
    const response = await this.request(
      "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
      {
        method: "POST",
        body: new URLSearchParams({ client_id: this.dependencies.clientId, scope }),
      },
    );
    if (!response.ok)
      throw new MicrosoftAccountError(
        "Microsoft sign-in could not start. This installation's Microsoft app needs public-client sign-in enabled.",
      );
    const code = decode(DeviceCode, await response.json());
    const url = new URL(code.verification_uri);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "microsoft.com" || url.hostname.endsWith(".microsoft.com"))
    )
      throw new MicrosoftAccountError(
        "Microsoft returned an unexpected sign-in address. Try again.",
      );
    if (generation !== this.generation)
      throw new MicrosoftAccountError("This sign-in was cancelled. Start again.");
    const expiresAt = this.now() + code.expires_in * 1000;
    const interval = Math.max(5, code.interval ?? 5);
    this.pending = {
      code: code.device_code,
      expiresAt,
      nextPoll: this.now() + interval * 1000,
      interval,
      sharePoint,
      generation,
    };
    return {
      userCode: code.user_code,
      verificationUrl: code.verification_uri,
      expiresAt,
      intervalSeconds: interval,
    };
  }
  async finish(): Promise<{ waiting: string } | { status: MicrosoftStatus }> {
    const pending = this.pending;
    if (!pending || this.now() >= pending.expiresAt) {
      this.pending = null;
      throw new MicrosoftAccountError(
        "That sign-in expired or was cancelled. Start sign-in again; your Task is kept.",
      );
    }
    if (this.now() < pending.nextPoll)
      return {
        waiting: "Finish signing in on Microsoft's page, then check again in a few seconds.",
      };
    pending.nextPoll = this.now() + pending.interval * 1000;
    const response = await this.request(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.dependencies.clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.code,
      }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = decode(OAuthError, payload).error;
      if (error === "authorization_pending" || error === "slow_down") {
        if (error === "slow_down") {
          pending.interval += 5;
          pending.nextPoll = this.now() + pending.interval * 1000;
        }
        return {
          waiting:
            "Microsoft is still waiting for your sign-in. Complete it in the sign-in page, then check again.",
        };
      }
      this.pending = null;
      throw new MicrosoftAccountError(
        error === "authorization_declined"
          ? "Microsoft sign-in was declined. Start again if you want to connect."
          : "Microsoft did not approve the connection. If this is a work account, ask your administrator about consent, or try again without SharePoint.",
      );
    }
    const token = decode(Token, payload);
    if (!token.refresh_token)
      throw new MicrosoftAccountError(
        "Microsoft did not grant ongoing access. Sign in again and allow the requested read access.",
      );
    const accountResponse = await this.request(
      `${GRAPH_ROOT}/me?$select=displayName,mail,userPrincipalName`,
      { headers: { authorization: `Bearer ${token.access_token}` } },
    );
    if (!accountResponse.ok)
      throw new MicrosoftAccountError(
        "Microsoft signed you in but your account could not be read. Start again or ask your administrator about access.",
      );
    const account = decode(
      Schema.Struct({ displayName: Schema.String }),
      await accountResponse.json(),
    );
    if (pending.generation !== this.generation)
      throw new MicrosoftAccountError("This sign-in was cancelled. Start again.");
    const saved = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: this.now() + token.expires_in * 1000,
      account: account.displayName,
      sharePoint: pending.sharePoint,
    };
    await this.dependencies.storage.set(
      SECRET_NAME,
      new TextEncoder().encode(JSON.stringify(saved)),
    );
    // Disconnect can arrive while storage is being updated; it wins.
    if (pending.generation !== this.generation) {
      await this.dependencies.storage.remove(SECRET_NAME);
      throw new MicrosoftAccountError("This sign-in was cancelled.");
    }
    this.pending = null;
    return { status: await this.status() };
  }
  async disconnect(): Promise<MicrosoftStatus> {
    this.generation++;
    this.pending = null;
    await this.dependencies.storage.remove(SECRET_NAME);
    return this.status();
  }
  private async access() {
    this.requireConfigured();
    const saved = await this.saved();
    if (!saved)
      throw new MicrosoftAccountError(
        "Connect Microsoft in Settings → Connected apps, then return to this Task. No work has been discarded.",
      );
    if (saved.expiresAt > this.now() + 60_000) return saved;
    if (this.refresh) return this.refresh;
    const generation = this.generation;
    this.refresh = (async () => {
      const response = await this.request(TOKEN_URL, {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.dependencies.clientId,
          grant_type: "refresh_token",
          refresh_token: saved.refreshToken,
        }),
      });
      if (!response.ok)
        throw new MicrosoftAccountError(
          "Microsoft needs you to reconnect. Open Settings → Connected apps and sign in again; your Task is kept.",
        );
      const token = decode(Token, await response.json());
      const next = {
        ...saved,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? saved.refreshToken,
        expiresAt: this.now() + token.expires_in * 1000,
      };
      if (generation !== this.generation)
        throw new MicrosoftAccountError("Microsoft was disconnected. Reconnect before continuing.");
      await this.dependencies.storage.set(
        SECRET_NAME,
        new TextEncoder().encode(JSON.stringify(next)),
      );
      if (generation !== this.generation) {
        await this.dependencies.storage.remove(SECRET_NAME);
        throw new MicrosoftAccountError("Microsoft was disconnected.");
      }
      return next;
    })();
    try {
      return await this.refresh;
    } finally {
      this.refresh = null;
    }
  }
  async downloadFile(id: string, driveId?: string): Promise<Uint8Array> {
    const token = await this.access();
    const base = driveId ? `/drives/${encodeURIComponent(driveId)}` : "/me/drive";
    const response = await this.dependencies.fetch(
      `${GRAPH_ROOT}${base}/items/${encodeURIComponent(id)}/content`,
      {
        headers: { authorization: `Bearer ${token.accessToken}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
    let content = response;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location)
        throw new MicrosoftAccountError(
          "Microsoft did not return a file download. Search for the file again.",
        );
      const url = new URL(location);
      if (
        url.protocol !== "https:" ||
        ![".sharepoint.com", ".1drv.com", ".onedrive.com", ".storage.live.com"].some((suffix) =>
          url.hostname.endsWith(suffix),
        )
      )
        throw new MicrosoftAccountError(
          "This file's download address is not supported. Open its source link or attach an exported copy.",
        );
      // The signed download URL authorizes this one file; never forward the account token.
      content = await this.request(url.toString(), {});
    }
    if (!content.ok || !content.body)
      throw new MicrosoftAccountError(
        content.status === 401
          ? "Reconnect Microsoft in Settings → Connected apps, then retry this file."
          : "Microsoft could not download this file. Check permission or attach an exported copy.",
      );
    const limit = 10 * 1024 * 1024;
    if (Number(content.headers.get("content-length")) > limit) {
      await content.body.cancel();
      throw new MicrosoftAccountError(
        "This file is larger than 10 MB. Attach a smaller export or the sections you need.",
      );
    }
    const reader = content.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > limit)
          throw new MicrosoftAccountError(
            "This file is larger than 10 MB. Attach a smaller export or the sections you need.",
          );
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async graph(path: string, body?: object): Promise<unknown> {
    const token = await this.access();
    if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
      throw new MicrosoftAccountError("The Microsoft request is invalid.");
    if (path.startsWith("/sites") && !token.sharePoint)
      throw new MicrosoftAccountError(
        "SharePoint access is off. Reconnect with SharePoint enabled; a work administrator may need to approve it.",
      );
    const response = await this.request(`${GRAPH_ROOT}${path}`, {
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        Prefer: 'outlook.body-content-type="text"',
      },
    });
    if (response.status === 401)
      throw new MicrosoftAccountError(
        "Microsoft needs you to reconnect in Settings → Connected apps. Your work is kept.",
      );
    if (response.status === 403)
      throw new MicrosoftAccountError(
        "Microsoft did not allow this read. Your work administrator may need to approve access; you can attach exported files instead.",
      );
    if (response.status === 429)
      throw new MicrosoftAccountError(
        "Microsoft is busy. Wait a little and retry; your work is kept.",
      );
    if (!response.ok)
      throw new MicrosoftAccountError(
        "That Microsoft item could not be read. It may have moved or been removed; search again.",
      );
    return response.json();
  }
}
