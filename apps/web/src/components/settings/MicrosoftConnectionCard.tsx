import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MicrosoftAction,
  MicrosoftSignIn,
  MicrosoftStatus,
} from "@t3tools/shared/microsoftConnection";
import type { EnvironmentId } from "@t3tools/contracts";
import { ConnectedAppsHttp } from "@t3tools/client-runtime/state/connected-apps";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "~/connection/runtime";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import { useAtomCommand } from "~/state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";

const requestMicrosoft = createEnvironmentCommand(connectionAtomRuntime, {
  label: "connected-apps:microsoft",
  execute: (action: typeof MicrosoftAction.Type) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
      if (!prepared)
        return {
          kind: "error" as const,
          message: "Reconnect this computer to manage your Microsoft account.",
        };
      const client = yield* ConnectedAppsHttp;
      return yield* client.microsoft(prepared, action);
    }),
});
export function MicrosoftConnectionCard() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return (
    <SettingsSection title="Microsoft" id="microsoft">
      <Connection key={environmentId} environmentId={environmentId} />
    </SettingsSection>
  );
}
function Connection({ environmentId }: { environmentId: EnvironmentId | null }) {
  const request = useAtomCommand(requestMicrosoft, { reportFailure: false });
  const [status, setStatus] = useState<MicrosoftStatus | null>(null);
  const [signIn, setSignIn] = useState<MicrosoftSignIn | null>(null);
  const [sharePoint, setSharePoint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (action: typeof MicrosoftAction.Type) => {
      if (!environmentId || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const result = await request({ environmentId, input: action });
        if (!mounted.current) return;
        if (result._tag === "Failure") {
          setMessage("Could not reach this computer. Reconnect and try again; your Task is kept.");
          return;
        }
        const response = result.value;
        if (response.kind === "status") {
          setStatus(response.status);
          setSharePoint(response.status.sharePoint);
          setSignIn(null);
        } else if (response.kind === "sign-in") setSignIn(response.signIn);
        else setMessage(response.message);
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [environmentId, request],
  );
  useEffect(() => {
    void run({ action: "status" });
  }, [run]);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Find and read Outlook email, calendar events and OneDrive files when you ask. SharePoint is
        optional. Doer does not send messages or change your account. Selected content is shared
        with the AI service you choose for the Task.
      </p>
      {!environmentId ? (
        <p>Select a connected computer to manage its account.</p>
      ) : status === null ? (
        <p role="status">{busy ? "Checking your connection…" : "Connection unavailable."}</p>
      ) : !status.configured ? (
        <p>
          This installation does not have Microsoft sign-in configured yet. You can attach exported
          files to a Task.
        </p>
      ) : (
        <>
          <p className="text-sm">
            {status.connected
              ? `Connected as ${status.account ?? "your Microsoft account"}`
              : "Not connected"}
            {status.connected && status.sharePoint ? " · SharePoint enabled" : ""}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sharePoint}
              disabled={busy || signIn !== null}
              onChange={(event) => setSharePoint(event.target.checked)}
            />{" "}
            Include SharePoint work files
          </label>
          <p className="text-xs text-muted-foreground">
            A work administrator may need to approve read access. You can connect without SharePoint
            or attach files instead.
          </p>
          {signIn ? (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <p>
                Open Microsoft's sign-in page and enter <strong>{signIn.userCode}</strong>. Complete
                sign-in there, then return here.
              </p>
              <a
                href={signIn.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm underline"
              >
                Open Microsoft sign-in
              </a>
              <p className="text-xs text-muted-foreground">
                Expires at {new Date(signIn.expiresAt).toLocaleTimeString()}. Keep passwords and
                verification codes on Microsoft's page.
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void run({ action: "finish" })}>
                  I've signed in · check connection
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run({ action: "start", sharePoint })}
                >
                  Start again
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run({ action: "start", sharePoint })}
            >
              {status.connected ? "Reconnect Microsoft" : "Connect Microsoft"}
            </Button>
          )}
          {status.connected || signIn ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ action: "disconnect" })}
            >
              {signIn ? "Cancel sign-in and disconnect" : "Disconnect Microsoft"}
            </Button>
          ) : null}
        </>
      )}
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || !environmentId}
        onClick={() => void run({ action: "status" })}
      >
        Check connection
      </Button>
    </div>
  );
}
