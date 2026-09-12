import { describe, expect, it } from "vite-plus/test";

import { AutomationId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { Automation, OrchestrationShellSnapshot } from "@t3tools/contracts";

import { applyShellStreamEvent } from "./shellReducer.ts";

const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-09-18T12:00:00.000Z",
};

function makeAutomation(id: string): Automation {
  return {
    id: AutomationId.make(id),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    title: `Automation ${id}`,
    prompt: "Summarize overnight activity.",
    schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
    state: "active",
    dedicatedThread: true,
    nextFireAt: "2026-09-19T09:00:00.000Z",
    lastFiredAt: null,
    runs: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("applyShellStreamEvent automations", () => {
  it("upserts automations into snapshots that predate the field", () => {
    const automation = makeAutomation("automation-1");
    const next = applyShellStreamEvent(baseSnapshot, {
      kind: "automation-upserted",
      sequence: 1,
      automation,
    });
    expect(next.automations).toEqual([automation]);
    expect(next.snapshotSequence).toBe(1);
  });

  it("replaces an existing automation on upsert", () => {
    const automation = makeAutomation("automation-1");
    const snapshot: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 1,
      automations: [automation, makeAutomation("automation-2")],
    };
    const updated = { ...automation, title: "Renamed", updatedAt: "2026-09-02T00:00:00.000Z" };
    const next = applyShellStreamEvent(snapshot, {
      kind: "automation-upserted",
      sequence: 2,
      automation: updated,
    });
    expect(next.automations).toHaveLength(2);
    expect(next.automations?.[0]?.title).toBe("Renamed");
    expect(next.automations?.[1]?.id).toBe("automation-2");
  });

  it("removes automations without touching threads", () => {
    const snapshot: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 1,
      automations: [makeAutomation("automation-1")],
    };
    const next = applyShellStreamEvent(snapshot, {
      kind: "automation-removed",
      sequence: 2,
      automationId: AutomationId.make("automation-1"),
    });
    expect(next.automations).toEqual([]);
    expect(next.threads).toEqual([]);
    expect(next.snapshotSequence).toBe(2);
  });

  it("ignores stale automation events without mutating the snapshot", () => {
    const snapshot: OrchestrationShellSnapshot = {
      ...baseSnapshot,
      snapshotSequence: 4,
      automations: [makeAutomation("automation-1")],
    };
    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshot, {
        kind: "automation-upserted",
        sequence,
        automation: makeAutomation("automation-1"),
      });
      expect(next).toBe(snapshot);
    }
  });
});
