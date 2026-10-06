import { EventId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toolOutputImageResources } from "./toolOutput.ts";

const threadId = ThreadId.make("thread-1");
const activityId = EventId.make("activity-1");

const projectedItem = {
  type: "mcp_tool_call",
  tool: "device_screenshot",
  result: {
    content: "Captured the home screen.",
    images: [
      { type: "image", mimeType: "image/png" },
      { type: "image", mimeType: "image/svg+xml" },
    ],
  },
};

describe("toolOutputImageResources", () => {
  it("routes a projected screenshot marker to an image asset, preserving text", () => {
    expect(toolOutputImageResources({ threadId, activityId, toolData: projectedItem })).toEqual([
      { _tag: "tool-output-image", threadId, activityId, index: 0 },
    ]);
  });

  it("reads markers from a bare result when no item envelope exists", () => {
    expect(
      toolOutputImageResources({
        threadId,
        activityId,
        toolData: { result: projectedItem.result },
      }),
    ).toEqual([{ _tag: "tool-output-image", threadId, activityId, index: 0 }]);
  });

  it("reads markers from a data envelope holding an item", () => {
    expect(
      toolOutputImageResources({
        threadId,
        activityId,
        toolData: { item: projectedItem },
      }),
    ).toEqual([{ _tag: "tool-output-image", threadId, activityId, index: 0 }]);
  });

  it("returns no images when the projection carries none", () => {
    expect(toolOutputImageResources({ threadId, activityId, toolData: null })).toEqual([]);
    expect(
      toolOutputImageResources({
        threadId,
        activityId,
        toolData: { result: { content: "ok" } },
      }),
    ).toEqual([]);
  });
});
