import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkFirstTaskFile,
  FIRST_TASK_MIN_ASSISTANT_CHARS,
  formatFirstTaskFileSize,
  getFirstTaskTurnOutcome,
  type FirstTaskTurnSnapshot,
} from "./firstTask.logic";

function snapshot(overrides: Partial<FirstTaskTurnSnapshot> = {}): FirstTaskTurnSnapshot {
  return {
    latestTurn: null,
    session: null,
    messages: [],
    ...overrides,
  };
}

const EXPLANATION =
  "Sales rose 13.7% to $184,500, beating the $175,000 target. The Trail Backpack surged on an influencer mention while the Cozy Lamp slipped on faulty dimmers.";

describe("getFirstTaskTurnOutcome", () => {
  it("waits before anything exists", () => {
    expect(getFirstTaskTurnOutcome(null)).toBe("waiting");
    expect(getFirstTaskTurnOutcome(snapshot())).toBe("waiting");
  });

  it("reports running turns", () => {
    expect(
      getFirstTaskTurnOutcome(
        snapshot({
          latestTurn: { turnId: "t1", state: "running", assistantMessageId: null },
          session: { status: "running" },
        }),
      ),
    ).toBe("running");
  });

  it("counts a finished turn with real assistant output as success", () => {
    expect(
      getFirstTaskTurnOutcome(
        snapshot({
          latestTurn: { turnId: "t1", state: "completed", assistantMessageId: "m1" },
          session: { status: "ready" },
          messages: [{ role: "assistant", text: EXPLANATION, turnId: "t1" }],
        }),
      ),
    ).toBe("succeeded");
  });

  it("ignores assistant text from an older turn", () => {
    expect(
      getFirstTaskTurnOutcome(
        snapshot({
          latestTurn: { turnId: "t2", state: "completed", assistantMessageId: null },
          session: { status: "ready" },
          messages: [{ role: "assistant", text: EXPLANATION, turnId: "t1" }],
        }),
      ),
    ).toBe("waiting");
  });

  it("waits when the finished turn has no substantive text yet", () => {
    expect(
      getFirstTaskTurnOutcome(
        snapshot({
          latestTurn: { turnId: "t1", state: "completed", assistantMessageId: null },
          session: { status: "ready" },
          messages: [{ role: "assistant", text: "ok", turnId: "t1" }],
        }),
      ),
    ).toBe("waiting");
    expect(EXPLANATION.length).toBeGreaterThanOrEqual(FIRST_TASK_MIN_ASSISTANT_CHARS);
  });

  it("treats turn and session errors as terminal failures", () => {
    expect(
      getFirstTaskTurnOutcome(
        snapshot({
          latestTurn: { turnId: "t1", state: "error", assistantMessageId: null },
          session: { status: "ready" },
          messages: [{ role: "assistant", text: EXPLANATION, turnId: "t1" }],
        }),
      ),
    ).toBe("failed");
    expect(
      getFirstTaskTurnOutcome(
        snapshot({
          latestTurn: { turnId: "t1", state: "completed", assistantMessageId: "m1" },
          session: { status: "error" },
          messages: [{ role: "assistant", text: EXPLANATION, turnId: "t1" }],
        }),
      ),
    ).toBe("failed");
  });

  it("does not fail an interrupted turn the user stopped", () => {
    expect(
      getFirstTaskTurnOutcome(
        snapshot({
          latestTurn: { turnId: "t1", state: "interrupted", assistantMessageId: null },
          session: { status: "ready" },
        }),
      ),
    ).toBe("waiting");
  });
});

describe("checkFirstTaskFile", () => {
  it("rejects empty and oversized files", () => {
    expect(checkFirstTaskFile({ size: 0 })).toEqual({
      ok: false,
      message: expect.stringContaining("empty"),
    });
    const over = checkFirstTaskFile({ size: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain("50 MB");
  });

  it("accepts ordinary documents", () => {
    expect(checkFirstTaskFile({ size: 2048 })).toEqual({ ok: true });
  });
});

describe("formatFirstTaskFileSize", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatFirstTaskFileSize(512)).toBe("512 B");
    expect(formatFirstTaskFileSize(2048)).toBe("2.0 KB");
    expect(formatFirstTaskFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
