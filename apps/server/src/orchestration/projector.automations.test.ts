import {
  AutomationId,
  CommandId,
  EventId,
  type AutomationSchedule,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-09-18T12:00:00.000Z";
const SLOT = "2026-09-18T09:00:00.000Z";
const DAILY: AutomationSchedule = { kind: "daily", time: "09:00", timezone: "UTC" };

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateId: string;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "automation",
    aggregateId: AutomationId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const createdPayload = {
  automationId: "automation-1",
  projectId: "project-1",
  threadId: "thread-1",
  title: "Morning brief",
  prompt: "Summarize overnight activity.",
  schedule: DAILY,
  nextFireAt: SLOT,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("automation projector", () => {
  it.effect("applies the automation lifecycle into the read model", () =>
    Effect.gen(function* () {
      let model = createEmptyReadModel(NOW);
      expect(model.automations).toEqual([]);

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "automation.created",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: createdPayload,
        }),
      );
      expect(model.automations).toHaveLength(1);
      expect(model.automations?.[0]).toMatchObject({
        id: "automation-1",
        projectId: "project-1",
        threadId: "thread-1",
        state: "active",
        nextFireAt: SLOT,
        lastFiredAt: null,
        runs: [],
        deletedAt: null,
      });

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 2,
          type: "automation.paused",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: { automationId: "automation-1", updatedAt: NOW },
        }),
      );
      // Pausing clears the firing slot so a paused row is never due.
      expect(model.automations?.[0]).toMatchObject({ state: "paused", nextFireAt: null });

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 3,
          type: "automation.resumed",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: { automationId: "automation-1", nextFireAt: SLOT, updatedAt: NOW },
        }),
      );
      expect(model.automations?.[0]).toMatchObject({ state: "active", nextFireAt: SLOT });

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 4,
          type: "automation.fired",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: {
            automationId: "automation-1",
            run: {
              occurrenceKey: SLOT,
              threadId: "thread-1",
              firedAt: NOW,
              outcome: "ran",
            },
            state: "active",
            nextFireAt: "2026-09-19T09:00:00.000Z",
            updatedAt: NOW,
          },
        }),
      );
      expect(model.automations?.[0]).toMatchObject({
        state: "active",
        nextFireAt: "2026-09-19T09:00:00.000Z",
        lastFiredAt: NOW,
      });
      expect(model.automations?.[0]?.runs).toHaveLength(1);

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 5,
          type: "automation.deleted",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: { automationId: "automation-1", deletedAt: NOW, updatedAt: NOW },
        }),
      );
      expect(model.automations?.[0]).toMatchObject({ deletedAt: NOW, nextFireAt: null });
    }),
  );

  it.effect("caps run history at the most recent runs", () =>
    Effect.gen(function* () {
      let model = createEmptyReadModel(NOW);
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "automation.created",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: createdPayload,
        }),
      );
      for (let index = 0; index < 60; index += 1) {
        model = yield* projectEvent(
          model,
          makeEvent({
            sequence: 2 + index,
            type: "automation.fired",
            occurredAt: NOW,
            aggregateId: "automation-1",
            payload: {
              automationId: "automation-1",
              run: {
                occurrenceKey: `slot-${index}`,
                threadId: "thread-1",
                firedAt: NOW,
                outcome: "ran",
              },
              state: "active",
              nextFireAt: SLOT,
              updatedAt: NOW,
            },
          }),
        );
      }
      expect(model.automations?.[0]?.runs).toHaveLength(50);
      expect(model.automations?.[0]?.runs.at(-1)?.occurrenceKey).toBe("slot-59");
    }),
  );

  it.effect("recreating a deleted id resets the row", () =>
    Effect.gen(function* () {
      let model = createEmptyReadModel(NOW);
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "automation.created",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: createdPayload,
        }),
      );
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 2,
          type: "automation.deleted",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: { automationId: "automation-1", deletedAt: NOW, updatedAt: NOW },
        }),
      );
      expect(model.automations).toHaveLength(1);
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 3,
          type: "automation.created",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: createdPayload,
        }),
      );
      expect(model.automations).toHaveLength(1);
      expect(model.automations?.[0]).toMatchObject({ deletedAt: null, runs: [] });
    }),
  );

  it.effect("ignores automation events when the model predates automations", () =>
    Effect.gen(function* () {
      // Read models built before the field existed carry no `automations` key;
      // the projector treats that as empty rather than failing.
      const legacy = {
        snapshotSequence: 0,
        projects: [],
        threads: [],
        updatedAt: NOW,
      };
      const next = yield* projectEvent(
        legacy,
        makeEvent({
          sequence: 1,
          type: "automation.created",
          occurredAt: NOW,
          aggregateId: "automation-1",
          payload: createdPayload,
        }),
      );
      expect(next.automations).toHaveLength(1);
    }),
  );
});
