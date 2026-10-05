import type { EnvironmentId, GmailConnectionStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { isElectron } from "../../env";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const gmailRequest = <A, E>(
  request: (client: PrimaryEnvironmentHttpClient["Service"]) => Effect.Effect<A, E>,
) => runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(request)));

export function GmailConnectionControl({
  enabled,
  environmentId,
  autoConnect = true,
}: {
  enabled: boolean;
  environmentId: EnvironmentId | null;
  autoConnect?: boolean;
}) {
  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const operation = useRef(0);
  const connecting = useRef(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const onPrimary = environmentId !== null && environmentId === primaryEnvironmentId;
  const onHostComputer =
    isElectron ||
    (typeof window !== "undefined" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname));

  const refresh = useCallback(async () => {
    if (!onPrimary) return;
    try {
      const next = await gmailRequest((client) => client.integrations.gmailStatus({ headers: {} }));
      setStatus(next);
    } catch {
      setStatus(null);
    }
  }, [onPrimary]);

  useEffect(() => {
    void refresh();
    return () => {
      operation.current += 1;
      connecting.current = false;
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    attempted.current = true;
    const currentOperation = ++operation.current;
    setBusy(true);
    try {
      const result = await gmailRequest((client) =>
        client.integrations.gmailBegin({ headers: {} }),
      );
      const shell = readLocalApi()?.shell;
      if (shell) await shell.openExternal(result.authorizationUrl);
      else window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      // The callback completes in the external browser. Poll only during sign-in.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (operation.current !== currentOperation) return;
        const next = await gmailRequest((client) =>
          client.integrations.gmailStatus({ headers: {} }),
        );
        setStatus(next);
        if (next.connected) return;
      }
      throw new Error("Sign-in timed out or was cancelled. Connect again to retry.");
    } catch (error) {
      if (operation.current !== currentOperation) return;
      toastManager.add({
        type: "error",
        title: "Gmail connection failed",
        description: error instanceof Error ? error.message : "Try connecting again.",
      });
    } finally {
      if (operation.current === currentOperation) {
        connecting.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    if (
      autoConnect &&
      enabled &&
      onPrimary &&
      onHostComputer &&
      status?.configured &&
      !status.connected &&
      !attempted.current
    ) {
      attempted.current = true;
      void connect();
    }
  }, [autoConnect, enabled, onPrimary, onHostComputer, status, connect]);

  const disconnect = useCallback(async () => {
    // Disconnect must not trigger the first-connection effect again.
    attempted.current = true;
    setBusy(true);
    try {
      await gmailRequest((client) => client.integrations.gmailDisconnect({ headers: {} }));
      await refresh();
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
      setBusy(false);
    }
  }, [refresh]);

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
