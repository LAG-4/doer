import { describe, expect, it } from "vite-plus/test";
import {
  searchGmailMessages,
  readGmailMessage,
  listGmailLabels,
  modifyGmailMessage,
} from "./gmailMailbox.ts";

const encoded = (body: string) => Buffer.from(body).toString("base64url");
const mail = {
  id: "abc123",
  threadId: "thread1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Hello",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Subject", value: "Invoice" },
      { name: "From", value: "sender@example.com" },
    ],
    parts: [
      {
        mimeType: "text/html",
        body: { data: encoded('<img src="https://tracker.invalid"><p>Hello</p>') },
      },
      { mimeType: "text/plain", body: { data: encoded("Hello ✓") } },
      {
        mimeType: "text/plain",
        filename: "private.txt",
        body: { data: encoded("attachment content") },
      },
    ],
  },
};

describe("Gmail mailbox API boundaries", () => {
  it("encodes searches, bounds pages and returns metadata without marking mail read", async () => {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const request = (async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, init });
      return Response.json(
        parsed.pathname.endsWith("/messages")
          ? { messages: [{ id: "abc123" }], nextPageToken: "next" }
          : mail,
      );
    }) as typeof fetch;
    const result = await searchGmailMessages(
      "private-token",
      { query: "from:a@example.com is:unread", maxResults: 2, pageToken: "a&b" },
      request,
    );
    expect(result).toMatchObject({
      messages: [{ id: "abc123", subject: "Invoice" }],
      nextPageToken: "next",
    });
    expect(calls[0]!.url.searchParams.get("pageToken")).toBe("a&b");
    expect(calls[1]!.url.searchParams.get("format")).toBe("metadata");
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
    await expect(
      searchGmailMessages("token", { query: "", maxResults: 21 }, request),
    ).rejects.toThrow("1–20");
    expect(calls).toHaveLength(2);
  });
  it("prefers text, lists attachment names only and never loads remote email images", async () => {
    const calls: string[] = [];
    const request = (async (url) => {
      calls.push(String(url));
      return Response.json(mail);
    }) as typeof fetch;
    expect(await readGmailMessage("token", "abc123", request)).toMatchObject({
      body: "Hello ✓",
      bodyFormat: "text",
      attachments: ["private.txt"],
      truncated: false,
    });
    expect(calls).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=full",
    ]);
  });
  it("falls back to UTF-8 when a part declares an unsupported charset", async () => {
    const request = (async () =>
      Response.json({
        ...mail,
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: 'text/plain; charset="x-made-up-99"' }],
              body: { data: encoded("Fallback ✓") },
            },
            {
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
              body: { data: encoded("Second ✓") },
            },
          ],
        },
      })) as typeof fetch;
    const result = await readGmailMessage("token", "abc123", request);
    expect(result.bodyFormat).toBe("text");
    expect(result.body).toContain("Fallback ✓");
    expect(result.body).toContain("Second ✓");
  });
  it("returns inert HTML when no text exists and reports truncation", async () => {
    const request = (async () =>
      Response.json({
        ...mail,
        payload: { mimeType: "text/html", body: { data: encoded("x".repeat(70_000)) } },
      })) as typeof fetch;
    const result = await readGmailMessage("token", "abc123", request);
    expect(result.bodyFormat).toBe("html");
    expect(result.body).toHaveLength(64_000);
    expect(result.truncated).toBe(true);
  });
  it("rejects path injection, oversized responses and errors without exposing server text", async () => {
    let called = false;
    const request = (async () => {
      called = true;
      return Response.json(mail);
    }) as typeof fetch;
    await expect(readGmailMessage("token", "../labels", request)).rejects.toThrow("Invalid Gmail");
    expect(called).toBe(false);
    await expect(
      readGmailMessage(
        "token",
        "abc123",
        (async () => new Response("x".repeat(2_000_001))) as typeof fetch,
      ),
    ).rejects.toThrow("too large");
    await expect(
      readGmailMessage(
        "token",
        "abc123",
        (async () => new Response("private-token-and-mail", { status: 403 })) as typeof fetch,
      ),
    ).rejects.toThrow("Gmail request failed (403).");
  });
  it("maps reversible organization operations to labels and Trash APIs without permanent deletion", async () => {
    const calls: { path: string; body: unknown; method: string | undefined }[] = [];
    const request = (async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
        method: init?.method,
      });
      return Response.json({ id: "abc123", labelIds: [] });
    }) as typeof fetch;
    for (const action of [
      "archive",
      "restore_inbox",
      "mark_read",
      "mark_unread",
      "trash",
      "restore_trash",
    ] as const)
      await modifyGmailMessage("token", { messageId: "abc123", action }, request);
    await modifyGmailMessage(
      "token",
      { messageId: "abc123", action: "add_label", labelId: "Label_1" },
      request,
    );
    expect(calls.map((c) => c.body)).toEqual([
      { removeLabelIds: ["INBOX"] },
      { addLabelIds: ["INBOX"] },
      { removeLabelIds: ["UNREAD"] },
      { addLabelIds: ["UNREAD"] },
      {},
      {},
      { addLabelIds: ["Label_1"] },
    ]);
    expect(calls[4]!.path).toContain("/trash");
    expect(calls[5]!.path).toContain("/untrash");
    expect(calls.every((c) => c.method === "POST")).toBe(true);
    await expect(
      modifyGmailMessage(
        "token",
        { messageId: "abc123", action: "add_label", labelId: "SENT" },
        request,
      ),
    ).rejects.toThrow("custom label");
    expect(calls).toHaveLength(7);
  });
  it("bounds label results", async () => {
    const labels = Array.from({ length: 501 }, (_, i) => ({
      id: `Label_${i}`,
      name: `Label ${i}`,
    }));
    const result = await listGmailLabels("token", (async () =>
      Response.json({ labels })) as typeof fetch);
    expect(result.labels).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });
});
