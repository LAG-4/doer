import { describe, expect, it } from "vite-plus/test";

import {
  MAX_TOOL_OUTPUT_IMAGES,
  omitToolOutputImageData,
  readToolOutputImage,
  toolOutputImages,
} from "./toolOutput.ts";

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("drops the bytes but keeps each image's position", () => {
    const omitted = omitToolOutputImageData({ content: [text, claudeImage, mcpImage] });
    expect(omitted).toEqual({
      content: [
        text,
        { type: "image", mimeType: "image/jpeg" },
        { type: "image", mimeType: "image/png" },
      ],
    });
    expect(toolOutputImages(omitted)).toEqual([
      { mimeType: "image/jpeg" },
      { mimeType: "image/png" },
    ]);
  });

  it("reads a marker without bytes as an image with no data", () => {
    expect(readToolOutputImage({ type: "image", mimeType: "image/png" })).toEqual({
      mimeType: "image/png",
    });
    expect(readToolOutputImage({ type: "image", mimeType: "image/svg+xml" })).toBeNull();
  });
});
