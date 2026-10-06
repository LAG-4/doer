import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GmailSendApproval, layer } from "./GmailSendApproval.ts";

const testLayer = layer.pipe(Layer.provide(NodeServices.layer));
it.effect("binds an approval to one task and consumes it once", () =>
  Effect.gen(function* () {
    const approvals = yield* GmailSendApproval;
    const thread = ThreadId.make("email-task");
    const pending = yield* approvals.create(thread);
    expect(yield* approvals.respond(ThreadId.make("other-task"), pending.requestId, "accept")).toBe(
      false,
    );
    expect(yield* approvals.respond(thread, pending.requestId, "accept")).toBe(true);
    expect(yield* pending.awaitDecision).toBe(true);
    expect(yield* approvals.respond(thread, pending.requestId, "accept")).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("never treats session permission or a closed review as email consent", () =>
  Effect.gen(function* () {
    const approvals = yield* GmailSendApproval;
    const thread = ThreadId.make("email-task");
    const pending = yield* approvals.create(thread);
    yield* approvals.respond(thread, pending.requestId, "acceptForSession");
    expect(yield* pending.awaitDecision).toBe(false);
    const closed = yield* approvals.create(thread);
    yield* closed.close;
    expect(yield* closed.awaitDecision).toBe(false);
    expect(yield* approvals.respond(thread, closed.requestId, "accept")).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("cancels reviews on stop, replacement and disconnect", () =>
  Effect.gen(function* () {
    const approvals = yield* GmailSendApproval;
    const thread = ThreadId.make("email-task");
    const first = yield* approvals.create(thread);
    const replacement = yield* approvals.create(thread);
    expect(yield* first.awaitDecision).toBe(false);
    yield* approvals.cancelThread(thread);
    expect(yield* replacement.awaitDecision).toBe(false);
    const another = yield* approvals.create(ThreadId.make("another-task"));
    yield* approvals.cancelAll;
    expect(yield* another.awaitDecision).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);
