// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readFirstTaskRecord,
  updateFirstTaskRecord,
  writeFirstTaskRecord,
  type FirstTaskRecord,
} from "./firstTaskRecord";

const KEY = "doer.first-task.v1";

function pending(): FirstTaskRecord {
  return {
    status: "pending",
    thread: { environmentId: "env-1", threadId: "thread-1" },
    fileName: "report.pdf",
    followUpDismissed: false,
    startedAt: "2026-09-30T00:00:00.000Z",
    completedAt: null,
  };
}

afterEach(() => {
  window.localStorage.removeItem(KEY);
});

describe("firstTaskRecord", () => {
  it("returns null when nothing was recorded", () => {
    expect(readFirstTaskRecord()).toBeNull();
  });

  it("round-trips a pending record with a stable snapshot", () => {
    writeFirstTaskRecord(pending());
    expect(readFirstTaskRecord()).toEqual(pending());
    expect(readFirstTaskRecord()).toBe(readFirstTaskRecord());
  });

  it("records skips without a thread pointer", () => {
    const now = "2026-09-30T00:00:00.000Z";
    writeFirstTaskRecord({
      status: "skipped",
      thread: null,
      fileName: "",
      followUpDismissed: true,
      startedAt: now,
      completedAt: now,
    });
    expect(readFirstTaskRecord()).toMatchObject({ status: "skipped", thread: null });
  });

  it("rejects malformed payloads", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ status: "pending" }));
    expect(readFirstTaskRecord()).toBeNull();
    window.localStorage.setItem(KEY, "not json");
    expect(readFirstTaskRecord()).toBeNull();
  });

  it("applies updates and skips no-op writes", () => {
    writeFirstTaskRecord(pending());
    const before = readFirstTaskRecord();
    updateFirstTaskRecord((current) => current);
    expect(readFirstTaskRecord()).toBe(before);
    updateFirstTaskRecord((current) =>
      current === null ? current : { ...current, status: "succeeded" },
    );
    expect(readFirstTaskRecord()).toMatchObject({ status: "succeeded" });
  });
});
