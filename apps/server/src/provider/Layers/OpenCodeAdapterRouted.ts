/**
 * OpenCodeAdapterRouted — version-routing facade over the v1 and v2 OpenCode
 * adapters.
 *
 * Both lines implement the same {@link OpenCodeAdapterShape}; this facade
 * owns one of each and routes every call to the line matching the connected
 * server:
 * - `startSession` probes the API version, then delegates. A version
 *   mismatch at connect (`OpenCodeApiVersionMismatchError` — e.g. the CLI
 *   was missing at probe time and the automatic install produced the other
 *   line) fails over to the other delegate exactly once.
 * - Session-bound calls route to the delegate owning the thread id.
 * - `listSessions` concatenates, `stopAll` stops both, and `streamEvents`
 *   merges both delegates' streams.
 *
 * Probing is per `startSession`, not memoized: external servers can be
 * swapped without restarting Doer, and the probes are cheap (a CLI
 * `--version` for spawned servers, a scoped version check for external
 * ones). A missing local CLI defaults to v2 — fresh automatic installs
 * prefer the v2 line.
 *
 * @module provider/Layers/OpenCodeAdapterRouted
 */
import type { OpenCodeSettings, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { parseGenericCliVersion } from "../providerSnapshot.ts";
import { OpenCodeApiVersionMismatchError, ProviderAdapterRequestError } from "../Errors.ts";
import {
  isOpenCodeV2Version,
  OpenCodeRuntime,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { makeOpenCodeAdapter, type OpenCodeAdapterLiveOptions } from "./OpenCodeAdapter.ts";
import { makeOpenCodeAdapterV2 } from "./OpenCodeAdapterV2.ts";

type RoutedAdapter = OpenCodeAdapterShape;

const isOpenCodeApiVersionMismatch = Schema.is(OpenCodeApiVersionMismatchError);

/**
 * Decide which adapter line drives the next session. Exported for unit
 * testing; `startSession` is the only production caller.
 */
export function probeRoutedApiVersion(
  runtime: OpenCodeRuntimeShape,
  input: {
    readonly binaryPath: string;
    readonly serverUrl: string;
    readonly serverPassword: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly managedDir?: string;
  },
): Effect.Effect<1 | 2> {
  if (input.serverUrl.trim().length > 0) {
    return runtime
      .connectToOpenCodeServer({
        binaryPath: input.binaryPath,
        directory: "",
        serverUrl: input.serverUrl,
        ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        ...(input.managedDir !== undefined ? { managedDir: input.managedDir } : {}),
      })
      .pipe(
        Effect.scoped,
        Effect.map((connection) => connection.apiVersion),
        Effect.orElseSucceed(() => 2 as const),
      );
  }
  return runtime
    .runOpenCodeCommand({
      binaryPath: input.binaryPath,
      args: ["--version"],
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.managedDir !== undefined ? { managedDir: input.managedDir } : {}),
    })
    .pipe(
      Effect.timeout("4 seconds"),
      Effect.option,
      Effect.map((result) => {
        // A missing CLI defaults to v2: fresh automatic installs prefer the
        // v2 line. An unparsable-but-present CLI stays on v1, the
        // battle-tested path; a wrong guess is corrected by the
        // connect-time mismatch failover in startSession.
        if (Option.isNone(result)) {
          return 2 as const;
        }
        const parsed = parseGenericCliVersion(result.value.stdout);
        return (parsed !== null && isOpenCodeV2Version(parsed) ? 2 : 1) as 1 | 2;
      }),
    );
}

export function makeRoutedOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const openCodeRuntime = yield* OpenCodeRuntime;
    const v1 = yield* makeOpenCodeAdapter(openCodeSettings, options);
    const v2 = yield* makeOpenCodeAdapterV2(openCodeSettings, options);

    const delegateForVersion = (apiVersion: 1 | 2): RoutedAdapter => (apiVersion === 2 ? v2 : v1);

    const probeForSession = () =>
      probeRoutedApiVersion(openCodeRuntime, {
        binaryPath: openCodeSettings.binaryPath,
        serverUrl: openCodeSettings.serverUrl,
        serverPassword: openCodeSettings.serverPassword,
        ...(options?.environment !== undefined ? { environment: options.environment } : {}),
        ...(options?.managedDir !== undefined ? { managedDir: options.managedDir } : {}),
      });

    const nativeCompactionStartOf = (adapter: RoutedAdapter) => {
      const compaction = adapter.compaction;
      return compaction !== undefined && compaction.type === "native"
        ? compaction.start
        : undefined;
    };

    const ownerOf = (threadId: ThreadId): Effect.Effect<RoutedAdapter | null> =>
      Effect.gen(function* () {
        if (yield* v1.hasSession(threadId)) {
          return v1;
        }
        if (yield* v2.hasSession(threadId)) {
          return v2;
        }
        return null;
      });

    const withOwner = <A, E, R>(
      threadId: ThreadId,
      use: (owner: RoutedAdapter) => Effect.Effect<A, E, R>,
      fallback: RoutedAdapter,
    ): Effect.Effect<A, E, R> =>
      ownerOf(threadId).pipe(Effect.flatMap((owner) => use(owner ?? fallback)));

    const startSession: RoutedAdapter["startSession"] = (input) =>
      Effect.gen(function* () {
        const apiVersion = yield* probeForSession();
        const primary = delegateForVersion(apiVersion);
        const startedExit = yield* Effect.exit(primary.startSession(input));
        if (startedExit._tag === "Success") {
          return startedExit.value;
        }
        const squashed = Cause.squash(startedExit.cause);
        if (isOpenCodeApiVersionMismatch(squashed)) {
          return yield* delegateForVersion(squashed.actual).startSession(input);
        }
        return yield* Effect.failCause(startedExit.cause);
      });

    return {
      provider: v1.provider,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn: (input) => withOwner(input.threadId, (owner) => owner.sendTurn(input), v1),
      compaction: {
        type: "native",
        start: (threadId, modelSelection) =>
          withOwner(
            threadId,
            (owner) => {
              const start = nativeCompactionStartOf(owner) ?? nativeCompactionStartOf(v1);
              if (start === undefined) {
                return Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "opencode",
                    method: "session.compact",
                    detail: "OpenCode compaction is unavailable.",
                  }),
                );
              }
              return start(threadId, modelSelection);
            },
            v1,
          ),
      },
      interruptTurn: (threadId, turnId) =>
        withOwner(threadId, (owner) => owner.interruptTurn(threadId, turnId), v1),
      respondToRequest: (threadId, requestId, decision) =>
        withOwner(threadId, (owner) => owner.respondToRequest(threadId, requestId, decision), v1),
      respondToUserInput: (threadId, requestId, answers) =>
        withOwner(threadId, (owner) => owner.respondToUserInput(threadId, requestId, answers), v1),
      stopSession: (threadId) => withOwner(threadId, (owner) => owner.stopSession(threadId), v1),
      listSessions: () =>
        Effect.zipWith(v1.listSessions(), v2.listSessions(), (first, second) => [
          ...first,
          ...second,
        ]),
      hasSession: (threadId) =>
        Effect.zipWith(v1.hasSession(threadId), v2.hasSession(threadId), (a, b) => a || b),
      readThread: (threadId) => withOwner(threadId, (owner) => owner.readThread(threadId), v1),
      rollbackThread: (threadId, numTurns) =>
        withOwner(threadId, (owner) => owner.rollbackThread(threadId, numTurns), v1),
      stopAll: () => v1.stopAll().pipe(Effect.andThen(v2.stopAll())),
      get streamEvents() {
        return Stream.merge(v1.streamEvents, v2.streamEvents);
      },
    } satisfies RoutedAdapter;
  });
}
