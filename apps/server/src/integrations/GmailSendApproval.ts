import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const isGmailSendApproval = (requestId: string) => requestId.startsWith("gmail-send:");

interface PendingEmailApproval {
  readonly requestId: ApprovalRequestId;
  readonly awaitDecision: Effect.Effect<boolean>;
  readonly close: Effect.Effect<void>;
}

export class GmailSendApproval extends Context.Service<
  GmailSendApproval,
  {
    readonly create: (threadId: ThreadId) => Effect.Effect<PendingEmailApproval>;
    readonly respond: (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) => Effect.Effect<boolean>;
    readonly cancelThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly cancelAll: Effect.Effect<void>;
  }
>()("@lag4/doer-cli/integrations/GmailSendApproval") {}

export const layer = Layer.effect(
  GmailSendApproval,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const pending = new Map<
      ApprovalRequestId,
      { threadId: ThreadId; decision: Deferred.Deferred<boolean> }
    >();
    const cancel = (threadId?: ThreadId) =>
      Effect.gen(function* () {
        for (const [requestId, request] of pending) {
          if (threadId !== undefined && request.threadId !== threadId) continue;
          pending.delete(requestId);
          yield* Deferred.succeed(request.decision, false);
        }
      });
    return GmailSendApproval.of({
      create: (threadId) =>
        Effect.gen(function* () {
          // Keep at most one unanswered email per task; superseded reviews fail closed.
          yield* cancel(threadId);
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const requestId = ApprovalRequestId.make(`gmail-send:${uuid}`);
          const decision = yield* Deferred.make<boolean>();
          pending.set(requestId, { threadId, decision });
          return {
            requestId,
            awaitDecision: Deferred.await(decision).pipe(
              Effect.timeoutOption("10 minutes"),
              Effect.map((result) => result._tag === "Some" && result.value),
            ),
            close: Effect.gen(function* () {
              pending.delete(requestId);
              yield* Deferred.succeed(decision, false);
            }),
          };
        }),
      respond: (threadId, requestId, decision) =>
        Effect.gen(function* () {
          const request = pending.get(requestId);
          if (!request || request.threadId !== threadId) return false;
          pending.delete(requestId);
          // Session-wide permission can never authorize an email send.
          yield* Deferred.succeed(request.decision, decision === "accept");
          return true;
        }),
      cancelThread: (threadId) => cancel(threadId),
      cancelAll: cancel(),
    });
  }),
);
