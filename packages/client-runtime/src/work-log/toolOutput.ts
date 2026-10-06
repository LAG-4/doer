import {
  isProviderSendTurnSupportedImageMimeType,
  type AssetResource,
  type EventId,
  type ThreadId,
} from "@t3tools/contracts";

export type ToolOutputImageResource = Extract<
  AssetResource,
  { readonly _tag: "tool-output-image" }
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isImageMarker(value: unknown): value is { readonly mimeType: string } {
  const record = asRecord(value);
  return (
    record !== null &&
    record.type === "image" &&
    typeof record.mimeType === "string" &&
    isProviderSendTurnSupportedImageMimeType(record.mimeType)
  );
}

/**
 * Images a tool returned inline for one work-log entry, as assets. The
 * projected timeline carries only their markers (mime type, no bytes); each
 * loads over HTTP by its index. Mirrors the server's read order: the stored
 * `item.result` wins when present, otherwise the stored `data.result`.
 */
export function toolOutputImageResources(input: {
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly toolData: unknown;
}): ReadonlyArray<ToolOutputImageResource> {
  if (input.activityId.trim().length === 0) return [];
  const activityId = input.activityId as EventId;
  const toolData = asRecord(input.toolData);
  const item = toolData ? asRecord(toolData.item) : null;
  const result = asRecord(item ? item.result : toolData?.result);
  const markers = result ? asRecord(result)?.images : undefined;
  if (!Array.isArray(markers)) return [];
  return markers.filter(isImageMarker).map((_, index) => ({
    _tag: "tool-output-image",
    threadId: input.threadId,
    activityId,
    index,
  }));
}
