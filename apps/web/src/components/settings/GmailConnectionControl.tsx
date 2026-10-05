import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { isElectron } from "../../env";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { getGmailConnectionState } from "./gmailConnectionState";

const gmailRequest = <A, E>(
  request: (client: PrimaryEnvironmentHttpClient["Service"]) => Effect.Effect<A, E>,
) => runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(request)));

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
  const state = useMemo(() => getGmailConnectionState(environmentId), [environmentId]);
  const { status, busy } = useSyncExternalStore(
    state.subscribe,
    state.getSnapshot,
    state.getSnapshot,
  );
  const attempted = useRef(false);
  const operation = useRef<number | null>(null);
  const signingIn = useRef(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const onPrimary = environmentId !== null && environmentId === primaryEnvironmentId;
  const onHostComputer =
    isElectron ||
    (typeof window !== "undefined" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname));

  const refresh = useCallback(async () => {
    if (!onPrimary) return;
    await state.refresh(() =>
      gmailRequest((client) => client.integrations.gmailStatus({ headers: {} })),
    );
  }, [onPrimary, state]);

  useEffect(() => {
    void refresh();
    // The switch can be changed by another paired client, including Disconnect.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [enabled, refresh]);

  useEffect(() => {
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
    if (!onPrimary || !onHostComputer || !enabled) return;
    const currentOperation = state.beginOperation();
    if (currentOperation === null) return;
    operation.current = currentOperation;
    signingIn.current = true;
    attempted.current = true;
    try {
      const result = await gmailRequest((client) =>
        client.integrations.gmailBegin({ headers: {} }),
      );
      if (!state.isCurrent(currentOperation)) return;
      const shell = readLocalApi()?.shell;
      if (shell) await shell.openExternal(result.authorizationUrl);
      else window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      // The callback completes in the external browser. Poll only during sign-in.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!state.isCurrent(currentOperation)) return;
        const next = await gmailRequest((client) =>
          client.integrations.gmailStatus({ headers: {} }),
        );
        if (!state.isCurrent(currentOperation)) return;
        state.setStatus(currentOperation, next);
        if (next.connected) return;
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
  }, [enabled, onHostComputer, onPrimary, state]);

  useEffect(() => {
    if (
      autoConnect &&
      enabled &&
      onPrimary &&
      onHostComputer &&
      status?.configured &&
      !busy &&
      !attempted.current
    ) {
      attempted.current = true;
      onConnectionAttempted?.();
      if (!status.connected) void connect();
    }
  }, [
    autoConnect,
    enabled,
    onPrimary,
    onHostComputer,
    status,
    busy,
    connect,
    onConnectionAttempted,
  ]);

  const disconnect = async () => {
    // Disconnect must not trigger the first-connection effect again.
    attempted.current = true;
    const currentOperation = state.beginOperation();
    if (currentOperation === null) return;
    operation.current = currentOperation;
    signingIn.current = false;
    try {
      await gmailRequest((client) => client.integrations.gmailDisconnect({ headers: {} }));
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

  if (!onPrimary) return null;
  if (status?.connected) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{status.email}</span>
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
  if (!onHostComputer)
    return <span className="text-xs text-muted-foreground">Connect Gmail on this computer.</span>;
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
