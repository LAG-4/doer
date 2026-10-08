import { describe, expect, it } from "vite-plus/test";
import { CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";
import { deriveTimelineEntries } from "../../session-logic";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import {
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
} from "./MessagesTimeline.logic";
import { deriveTurnTaskOutputs, buildRepeatTaskPrompt } from "./taskResultsPerTurn";

const time = (second: number) => new Date(Date.UTC(2026, 8, 4, 0, 0, second)).toISOString();

function user(id: string, second: number): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: `ask ${id}`,
    turnId: null,
    createdAt: time(second),
    updatedAt: time(second),
    streaming: false,
  };
}

function assistant(id: string, turn: TurnId, second: number, streaming = false): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text: `answer ${id}`,
    turnId: turn,
    createdAt: time(second),
    updatedAt: time(second),
    streaming,
  };
}

function checkpoint(
  turn: TurnId,
  assistantMessageId: string | null,
  second: number,
  files: Array<{ path: string; kind: string }>,
  status: TurnDiffSummary["status"] = "ready",
): TurnDiffSummary {
  return {
    turnId: turn,
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${String(turn)}`),
    status,
    files: files.map((file) => ({ ...file, additions: 1, deletions: 0 })),
    assistantMessageId: assistantMessageId ? MessageId.make(assistantMessageId) : null,
    completedAt: time(second),
  };
}

describe("buildRepeatTaskPrompt", () => {
  it("names this card's files so an older turn repeats its own work", () => {
    const prompt = buildRepeatTaskPrompt(["outputs/original.md"]);
    expect(prompt).toContain("outputs/original.md");
    expect(prompt).toContain("Review the sources, the result to produce, timing and permissions");
    expect(prompt).toContain("before saving a reminder");
    expect(prompt).not.toMatch(/turn-[a-z0-9-]+|message/i);
  });
});

describe("deriveTurnTaskOutputs", () => {
  it("groups ready outputs by turn and ignores non-output extensions", () => {
    const turnA = TurnId.make("turn-a");
    const byTurn = deriveTurnTaskOutputs([
      checkpoint(turnA, "a1", 10, [
        { path: "outputs/report.xlsx", kind: "created" },
        { path: "src/index.ts", kind: "modified" },
        { path: ".hidden/secret.md", kind: "created" },
      ]),
    ]);
    expect(byTurn.get(turnA)?.paths).toEqual(["outputs/report.xlsx"]);
  });

  it("skips non-ready checkpoints and honors in-turn deletes", () => {
    const turnA = TurnId.make("turn-a");
    const byTurn = deriveTurnTaskOutputs([
      checkpoint(turnA, "a1", 10, [{ path: "outputs/draft.md", kind: "created" }], "missing"),
      checkpoint(TurnId.make("turn-b"), "b1", 11, [
        { path: "outputs/keep.md", kind: "created" },
        { path: "outputs/keep.md", kind: "deleted" },
      ]),
    ]);
    expect(byTurn.has(turnA)).toBe(false);
    expect(byTurn.size).toBe(0);
  });

  it("merges multiple checkpoints of the same turn without duplicating paths", () => {
    const turnA = TurnId.make("turn-a");
    const byTurn = deriveTurnTaskOutputs([
      checkpoint(turnA, null, 10, [{ path: "outputs/a.md", kind: "created" }]),
      checkpoint(turnA, "a2", 12, [
        { path: "outputs/a.md", kind: "created" },
        { path: "outputs/b.pdf", kind: "created" },
      ]),
    ]);
    expect(byTurn.get(turnA)?.paths).toEqual(["outputs/a.md", "outputs/b.pdf"]);
    expect(byTurn.get(turnA)?.assistantMessageId).toBe("a2");
  });
});

describe("per-turn task results rows", () => {
  it("anchors one container after the terminal assistant message, not per chunk", () => {
    const turnA = TurnId.make("turn-a");
    const messages = [user("u1", 0), assistant("a1", turnA, 3), assistant("a2", turnA, 5)];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries(messages, [], []),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [
        checkpoint(turnA, "a2", 9, [{ path: "outputs/a.xlsx", kind: "created" }]),
      ],
      supportsConversationRollback: false,
    });
    const kinds = rows.map((row) => row.kind);
    expect(kinds.filter((kind) => kind === "task-results")).toHaveLength(1);
    const resultsIndex = rows.findIndex((row) => row.kind === "task-results");
    const lastAssistantIndex = rows.reduce(
      (acc, row, index) =>
        row.kind === "message" && row.message.role === "assistant" ? index : acc,
      -1,
    );
    expect(resultsIndex).toBe(lastAssistantIndex + 1);
    expect(rows[resultsIndex]).toMatchObject({
      kind: "task-results",
      turnId: turnA,
      paths: ["outputs/a.xlsx"],
    });
  });

  it("anchors after the terminal chunk even when the checkpoint stamps the first one", () => {
    const turnA = TurnId.make("turn-a");
    const messages = [user("u1", 0), assistant("a1", turnA, 3), assistant("a2", turnA, 5)];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries(messages, [], []),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [
        checkpoint(turnA, "a1", 9, [{ path: "outputs/a.xlsx", kind: "created" }]),
      ],
      supportsConversationRollback: false,
    });
    const results = rows.filter((row) => row.kind === "task-results");
    expect(results).toHaveLength(1);
    const resultsIndex = rows.findIndex((row) => row.kind === "task-results");
    const lastAssistantIndex = rows.reduce(
      (acc, row, index) =>
        row.kind === "message" && row.message.role === "assistant" ? index : acc,
      -1,
    );
    expect(resultsIndex).toBe(lastAssistantIndex + 1);
  });

  it("keeps older outputs with their own turn and never repeats them under the latest response", () => {
    const turnA = TurnId.make("turn-a");
    const turnB = TurnId.make("turn-b");
    const messages = [
      user("u1", 0),
      assistant("a1", turnA, 3),
      user("u2", 20),
      assistant("b1", turnB, 23),
    ];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries(messages, [], []),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [
        checkpoint(turnA, "a1", 9, [{ path: "outputs/original.md", kind: "created" }]),
        checkpoint(turnB, "b1", 29, [{ path: "outputs/original-revised.md", kind: "created" }]),
      ],
      supportsConversationRollback: false,
    });
    const results = rows.filter((row) => row.kind === "task-results");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ turnId: turnA, paths: ["outputs/original.md"] });
    expect(results[1]).toMatchObject({ turnId: turnB, paths: ["outputs/original-revised.md"] });
  });

  it("attaches generation without assistant text to the logical turn place", () => {
    const turnA = TurnId.make("turn-a");
    const messages = [user("u1", 0)];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries(
        messages,
        [],
        [
          {
            id: "tool-1",
            turnId: turnA,
            createdAt: time(2),
            label: "Saved file",
            tone: "tool",
            toolCallId: "tool-1",
            toolLifecycleStatus: "completed",
            sourceActivityKind: "tool.completed",
          },
        ],
      ),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [
        checkpoint(turnA, null, 9, [{ path: "outputs/tool-made.pdf", kind: "created" }]),
      ],
      supportsConversationRollback: false,
    });
    const resultsIndex = rows.findIndex((row) => row.kind === "task-results");
    expect(resultsIndex).toBeGreaterThan(-1);
    expect(rows[resultsIndex]).toMatchObject({ turnId: turnA });
  });

  it("renders no container for a later turn without outputs", () => {
    const turnA = TurnId.make("turn-a");
    const turnB = TurnId.make("turn-b");
    const messages = [
      user("u1", 0),
      assistant("a1", turnA, 3),
      user("u2", 20),
      assistant("b1", turnB, 23),
    ];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries(messages, [], []),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [
        checkpoint(turnA, "a1", 9, [{ path: "outputs/original.md", kind: "created" }]),
      ],
      supportsConversationRollback: false,
    });
    const results = rows.filter((row) => row.kind === "task-results");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ turnId: turnA });
  });

  it("reuses the results row while streaming text updates arrive", () => {
    const turnA = TurnId.make("turn-a");
    const live = TurnId.make("live-turn");
    const base = [user("u1", 0), assistant("a1", turnA, 3)];
    const secondUser = user("u2", 5);
    const streaming = assistant("live", live, 7, true);
    const messages = [...base, secondUser, streaming];
    const input = {
      timelineEntries: deriveTimelineEntries(messages, [], []),
      latestTurn: {
        turnId: live,
        state: "running" as const,
        startedAt: time(5),
        completedAt: null,
      },
      runningTurnId: live,
      isWorking: true,
      activeTurnStartedAt: time(5),
      turnDiffSummaries: [
        checkpoint(turnA, "a1", 4, [{ path: "outputs/original.md", kind: "created" }]),
      ],
      supportsConversationRollback: false,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const previous = deriveMessagesTimelineRowsWithState(input);
    const updated = deriveMessagesTimelineRowsWithState(
      {
        ...input,
        timelineEntries: deriveTimelineEntries(
          [...base, secondUser, { ...streaming, text: "more tokens" }],
          [],
          [],
        ),
        turnDiffSummaries: [...input.turnDiffSummaries],
        latestTurn: { ...input.latestTurn },
      },
      previous,
    );
    const before = previous.rows.find((row) => row.kind === "task-results");
    const after = updated.rows.find((row) => row.kind === "task-results");
    expect(before).toBeDefined();
    expect(after).toBe(before);
  });
});
