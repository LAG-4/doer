import { isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

/** An image a tool returned inline. `data` is base64; a projected read omits it. */
export interface ToolOutputImage {
  readonly mimeType: string;
  readonly data?: string;
}

/**
 * Reads one image block in the MCP `{ data, mimeType }` shape or the Anthropic
 * `{ source: { type: "base64", media_type, data } }` shape Claude stores.
 * Only raster types are recognized, so the server never serves an agent's SVG
 * or HTML inline.
 */
export function readToolOutputImage(block: unknown): ToolOutputImage | null {
  if (!Predicate.isObject(block) || block.type !== "image") return null;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return null;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  const data = source === undefined ? block.data : source.data;
  if (typeof mimeType !== "string" || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
    return null;
  }
  const image = { mimeType: mimeType.toLowerCase() };
  return typeof data === "string" ? { ...image, data } : image;
}

/** Tools return a block, a list of blocks, or an MCP result with a `content` list. */
function outputBlocks(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  if (Predicate.isObject(value) && Array.isArray(value.content)) return value.content;
  return [value];
}

/** A tool returns one screenshot or a few frames; more would only flood the timeline. */
export const MAX_TOOL_OUTPUT_IMAGES = 8;

/**
 * The first images in a tool output, in order. The order is the
 * `tool-output-image` asset index, so servers and clients agree on it.
 */
export function toolOutputImages(value: unknown): ReadonlyArray<ToolOutputImage> {
  const images: ToolOutputImage[] = [];
  for (const block of outputBlocks(value)) {
    const image = readToolOutputImage(block);
    if (image === null) continue;
    images.push(image);
    if (images.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return images;
}

/**
 * Replaces each image's bytes with `{ type: "image", mimeType }` and keeps its
 * position, so projected reads stay small and clients load the bytes as assets.
 */
export function omitToolOutputImageData(value: unknown): unknown {
  const omit = (block: unknown) => {
    const image = readToolOutputImage(block);
    return image?.data === undefined ? block : { type: "image", mimeType: image.mimeType };
  };
  if (Array.isArray(value)) return value.map(omit);
  if (Predicate.isObject(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(omit) };
  }
  return omit(value);
}
