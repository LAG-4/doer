// @effect-diagnostics nodeBuiltinImport:off -- Gmail MIME bodies use Node's base64url decoder.
import * as Schema from "effect/Schema";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_BODY_CHARS = 64_000;

export const MailSummary = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  from: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  date: Schema.String,
  snippet: Schema.String,
  labelIds: Schema.Array(Schema.String),
});
export const MailContent = Schema.Struct({
  ...MailSummary.fields,
  body: Schema.String,
  bodyFormat: Schema.Literals(["text", "html", "none"]),
  truncated: Schema.Boolean,
  attachments: Schema.Array(Schema.String),
});
export const MailSearchResult = Schema.Struct({
  messages: Schema.Array(MailSummary),
  nextPageToken: Schema.optional(Schema.String),
});
export const MailLabel = Schema.Struct({ id: Schema.String, name: Schema.String });
export const MailLabelsResult = Schema.Struct({
  labels: Schema.Array(MailLabel),
  truncated: Schema.Boolean,
});
export const MailAction = Schema.Literals([
  "archive",
  "restore_inbox",
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
  "add_label",
  "remove_label",
  "trash",
  "restore_trash",
]);
export type MailAction = typeof MailAction.Type;
export interface MailChange {
  readonly messageId: string;
  readonly action: MailAction;
  readonly labelId?: string;
}
export interface MailSearch {
  readonly query: string;
  readonly maxResults?: number;
  readonly pageToken?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid Gmail response.");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
export function validateMailId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid Gmail message or label ID.");
}
export function validateMailChange(input: MailChange): void {
  validateMailId(input.messageId);
  if (input.action === "add_label" || input.action === "remove_label") {
    // System labels have dedicated actions; never let a label operation target SENT/DRAFTS.
    if (!input.labelId || !/^Label_[a-zA-Z0-9_-]{1,190}$/.test(input.labelId))
      throw new Error("Choose a custom label ID from gmail_list_labels.");
  } else if (input.labelId !== undefined) {
    throw new Error("Only add_label and remove_label accept a label ID.");
  }
}

async function requestJson(
  token: string,
  path: string,
  request: typeof fetch,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await request(`${API}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Gmail request failed (${response.status}).`);
  if (!response.body) throw new Error("Invalid Gmail response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Gmail message is too large to read in Doer.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
}

function summary(value: Record<string, unknown>) {
  const payload = value.payload === undefined ? {} : record(value.payload);
  const headers = Array.isArray(payload.headers) ? payload.headers.map(record) : [];
  const header = (name: string) =>
    string(headers.find((h) => string(h.name).toLowerCase() === name)?.value).slice(0, 2_000);
  const id = string(value.id);
  validateMailId(id);
  return {
    id,
    threadId: string(value.threadId),
    from: header("from"),
    to: header("to"),
    subject: header("subject"),
    date: header("date"),
    snippet: string(value.snippet).slice(0, 2_000),
    labelIds: strings(value.labelIds),
  };
}

export async function searchGmailMessages(
  token: string,
  input: MailSearch,
  request: typeof fetch = fetch,
) {
  const count = input.maxResults ?? 10;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20 ||
    input.query.length > 1_000 ||
    (input.pageToken?.length ?? 0) > 2_000
  )
    throw new Error("Search supports 1–20 messages per page and a query under 1,001 characters.");
  const params = new URLSearchParams({ q: input.query, maxResults: String(count) });
  if (input.pageToken) params.set("pageToken", input.pageToken);
  const page = await requestJson(token, `messages?${params}`, request);
  const ids = Array.isArray(page.messages) ? page.messages.slice(0, count).map(record) : [];
  const messages = [];
  // Bound requests and return headers only until the user asks to read a particular message.
  for (const item of ids) {
    const id = string(item.id);
    validateMailId(id);
    messages.push(summary(await requestJson(token, `messages/${id}?format=metadata`, request)));
  }
  return {
    messages,
    ...(typeof page.nextPageToken === "string" ? { nextPageToken: page.nextPageToken } : {}),
  };
}

export async function readGmailMessage(token: string, id: string, request: typeof fetch = fetch) {
  validateMailId(id);
  const value = await requestJson(token, `messages/${id}?format=full`, request);
  if (value.id !== id) throw new Error("Invalid Gmail message response.");
  const text: string[] = [],
    html: string[] = [],
    attachments: string[] = [];
  let parts = 0;
  const visit = (unknownPart: unknown, depth: number) => {
    if (depth > 32 || ++parts > 256) throw new Error("Gmail message has too many MIME parts.");
    const part = record(unknownPart);
    if (string(part.filename)) {
      attachments.push(string(part.filename).slice(0, 500));
      return;
    }
    if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
      const body = part.body === undefined ? {} : record(part.body);
      const headers = Array.isArray(part.headers) ? part.headers.map(record) : [];
      const contentType = string(
        headers.find((h) => string(h.name).toLowerCase() === "content-type")?.value,
      );
      const charset = /charset=["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? "utf-8";
      if (typeof body.data === "string") {
        // An unknown charset must not fail the whole message: fall back to
        // UTF-8 deterministically so the remaining parts still render.
        let decoded: string;
        try {
          decoded = new TextDecoder(charset).decode(Buffer.from(body.data, "base64url"));
        } catch {
          decoded = new TextDecoder("utf-8").decode(Buffer.from(body.data, "base64url"));
        }
        (part.mimeType === "text/plain" ? text : html).push(decoded);
      }
    }
    if (Array.isArray(part.parts)) for (const child of part.parts) visit(child, depth + 1);
  };
  if (value.payload) visit(value.payload, 0);
  const body = (text.length ? text : html).join("\n");
  return {
    ...summary(value),
    body: body.slice(0, MAX_BODY_CHARS),
    bodyFormat: text.length
      ? ("text" as const)
      : html.length
        ? ("html" as const)
        : ("none" as const),
    truncated: body.length > MAX_BODY_CHARS,
    attachments,
  };
}

export async function listGmailLabels(token: string, request: typeof fetch = fetch) {
  const value = await requestJson(token, "labels", request);
  const labels = Array.isArray(value.labels) ? value.labels.map(record) : [];
  return {
    labels: labels.slice(0, 500).map((l) => ({ id: string(l.id), name: string(l.name) })),
    truncated: labels.length > 500,
  };
}

export async function modifyGmailMessage(
  token: string,
  input: MailChange,
  request: typeof fetch = fetch,
) {
  validateMailChange(input);
  const actions = {
    archive: { removeLabelIds: ["INBOX"] },
    restore_inbox: { addLabelIds: ["INBOX"] },
    mark_read: { removeLabelIds: ["UNREAD"] },
    mark_unread: { addLabelIds: ["UNREAD"] },
    star: { addLabelIds: ["STARRED"] },
    unstar: { removeLabelIds: ["STARRED"] },
    add_label: { addLabelIds: [input.labelId] },
    remove_label: { removeLabelIds: [input.labelId] },
    trash: {},
    restore_trash: {},
  };
  const endpoint =
    input.action === "trash" ? "trash" : input.action === "restore_trash" ? "untrash" : "modify";
  const value = await requestJson(token, `messages/${input.messageId}/${endpoint}`, request, {
    method: "POST",
    body: JSON.stringify(actions[input.action]),
  });
  const id = string(value.id);
  if (id !== input.messageId) throw new Error("Invalid Gmail change response.");
  return { id, labelIds: strings(value.labelIds) };
}
