import type { EnvironmentId, GmailConnectionStatus } from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { ConnectedAppsHttp, GmailHttpError } from "@t3tools/client-runtime/state/connected-apps";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { connectionAtomRuntime } from "~/connection/runtime";
import { readLocalApi } from "~/localApi";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironment, useEnvironmentHttpBaseUrl } from "~/state/environments";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { getGmailConnectionState, resolveGmailHostAccess } from "./gmailConnectionState";

type GmailAction =
  | { readonly action: "status" }
  | { readonly action: "begin" }
  | { readonly action: "disconnect" };

type GmailResult =
  | { readonly kind: "status"; readonly status: GmailConnectionStatus }
  | { readonly kind: "authorization"; readonly authorizationUrl: string }
  | { readonly kind: "disconnected" }
  | { readonly kind: "error"; readonly message: string };

const isGmailHttpError = Schema.is(GmailHttpError);

const requestGmail = createEnvironmentCommand(connectionAtomRuntime, {
  label: "connected-apps:gmail",
  execute: (input: GmailAction) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
      if (!prepared)
        return {
          kind: "error" as const,
          message: "Reconnect this computer to manage its Gmail account.",
        };
      const client = yield* ConnectedAppsHttp;
      // Preserve readable server failures (revocation, key, configuration,
      // sign-in conflicts); only transport failures stay generic.
      const failure = (action: GmailAction["action"]) => (error: unknown) => {
        if (isGmailHttpError(error)) {
          return Effect.succeed({ kind: "error" as const, message: error.message });
        }
        return Effect.succeed({
          kind: "error" as const,
          message:
            action === "begin"
              ? "Could not start Gmail sign-in."
              : "Could not reach this computer.",
        });
      };
      if (input.action === "status") {
        return yield* client.gmailStatus(prepared).pipe(
          Effect.map((status) => ({ kind: "status" as const, status })),
          Effect.catch(failure("status")),
        );
      }
      if (input.action === "begin") {
        return yield* client.gmailBegin(prepared).pipe(
          Effect.map((begin) => ({
            kind: "authorization" as const,
            authorizationUrl: begin.authorizationUrl,
          })),
          Effect.catch(failure("begin")),
        );
      }
      return yield* client.gmailDisconnect(prepared).pipe(
        Effect.map((result) =>
          result.disconnected
            ? { kind: "disconnected" as const }
            : {
                kind: "error" as const,
                message: "Disconnect did not complete. Try again while online.",
              },
        ),
        Effect.catch(failure("disconnect")),
      );
    }),
});

export function GmailConnectionControl({
  enabled,
  environmentId,
  autoConnect = false,
  onConnectionAttempted,
}: {
  enabled: boolean;
  environmentId: EnvironmentId | null;
  autoConnect?: boolean;
  onConnectionAttempted?: () => void;
}) {
  const state = getGmailConnectionState(environmentId);
  const { status, busy } = useSyncExternalStore(
    state.subscribe,
    state.getSnapshot,
    state.getSnapshot,
  );
  const attempted = useRef(false);
  const operation = useRef<number | null>(null);
  const signingIn = useRef(false);
  const request = useAtomCommand(requestGmail, { reportFailure: false });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const environment = useEnvironment(environmentId);
  const host = resolveGmailHostAccess({
    httpBaseUrl,
    targetTag: environment?.entry?.target?._tag ?? null,
    computerLabel: environment?.label ?? null,
    isLoopback: isLoopbackHost,
  });

  const run = useCallback(
    async (action: GmailAction["action"]): Promise<GmailResult | null> => {
      if (environmentId === null || !host.reachable) return null;
      const result = await request({ environmentId, input: { action } });
      if (result._tag === "Failure")
        return { kind: "error", message: "Could not reach this computer." };
      return result.value;
    },
    [environmentId, host.reachable, request],
  );

  const refresh = useCallback(async () => {
    if (environmentId === null || !host.reachable) return;
    // The network request runs inside the refresh loader so its readVersion
    // guard applies to the whole round trip: a slow earlier request can never
    // overwrite a newer status.
    await state.refresh(async () => {
      const result = await run("status");
      if (result?.kind === "status") return result.status;
      throw new Error(result?.kind === "error" ? result.message : "Could not reach this computer.");
    });
  }, [environmentId, host.reachable, run, state]);

  useEffect(() => {
    void refresh();
    // The switch can be changed by another paired client, including Disconnect.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [enabled, refresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      state.cancelOperation(operation.current);
      operation.current = null;
    };
  }, [refresh, state]);

  useEffect(() => {
    if (!enabled && signingIn.current) state.cancelOperation(operation.current);
    if (!autoConnect || !enabled) attempted.current = false;
  }, [autoConnect, enabled, state]);

  const connect = useCallback(async () => {
    if (!host.onHost || !enabled) return;
    const currentOperation = state.beginOperation();
    if (currentOperation === null) return;
    operation.current = currentOperation;
    signingIn.current = true;
    attempted.current = true;
    try {
      const begun = await run("begin");
      if (!state.isCurrent(currentOperation)) return;
      if (begun?.kind === "error" || !begun || begun.kind !== "authorization") {
        throw new Error(begun?.kind === "error" ? begun.message : "Could not start Gmail sign-in.");
      }
      const shell = readLocalApi()?.shell;
      if (shell) await shell.openExternal(begun.authorizationUrl);
      else window.open(begun.authorizationUrl, "_blank", "noopener,noreferrer");
      // The callback completes in the external browser. Poll only during sign-in.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!state.isCurrent(currentOperation)) return;
        const next = await run("status");
        if (!state.isCurrent(currentOperation)) return;
        if (next?.kind === "status") {
          state.setStatus(currentOperation, next.status);
          if (next.status.connected) return;
        }
      }
      throw new Error("Sign-in timed out or was cancelled. Connect again to retry.");
    } catch (error) {
      if (!state.isCurrent(currentOperation)) return;
      toastManager.add({
        type: "error",
        title: "Gmail connection failed",
        description: error instanceof Error ? error.message : "Try connecting again.",
      });
    } finally {
      state.endOperation(currentOperation);
      if (operation.current === currentOperation) signingIn.current = false;
    }
  }, [enabled, host.onHost, run, state]);

  useEffect(() => {
    if (
      autoConnect &&
      enabled &&
      host.onHost &&
      status?.configured &&
      !busy &&
      !attempted.current
    ) {
      attempted.current = true;
      onConnectionAttempted?.();
      if (!status.connected) void connect();
    }
  }, [autoConnect, connect, enabled, host.onHost, onConnectionAttempted, status, busy]);

  const disconnect = async () => {
    // Disconnect must not trigger the first-connection effect again.
    attempted.current = true;
    const currentOperation = state.beginOperation();
    if (currentOperation === null) return;
    operation.current = currentOperation;
    signingIn.current = false;
    try {
      const result = await run("disconnect");
      // Only a confirmed server disconnect updates local state; anything
      // else (including unreachable) keeps the last known connection.
      if (result?.kind !== "disconnected") {
        throw new Error(
          result?.kind === "error" ? result.message : "Could not reach this computer.",
        );
      }
      state.setStatus(currentOperation, {
        configured: state.getSnapshot().status?.configured ?? true,
        connected: false,
        email: null,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't disconnect Gmail",
        description:
          error instanceof Error
            ? error.message
            : "Try again while online, or revoke Doer in your Google account connections.",
      });
    } finally {
      state.endOperation(currentOperation);
      void refresh();
    }
  };

  if (!host.reachable) return null;
  if (status?.connected) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-all text-xs text-muted-foreground">{status.email}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  }
  if (!enabled) return null;
  if (status && !status.configured)
    return (
      <span className="text-xs text-muted-foreground">
        Gmail isn't available in this setup. Google sign-in and protected storage are required.
      </span>
    );
  if (!host.onHost && host.guidance !== null)
    return <span className="text-xs text-muted-foreground">{host.guidance}</span>;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || !status?.configured}
      onClick={() => void connect()}
    >
      {busy ? "Connecting…" : "Connect Gmail"}
    </Button>
  );
}
