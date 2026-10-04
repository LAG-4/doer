import type { GmailConnectionStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { isElectron } from "../../env";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const gmailRequest = <A, E>(
  request: (client: PrimaryEnvironmentHttpClient["Service"]) => Effect.Effect<A, E>,
) => runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(request)));

function GmailConnectionControl({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const { target } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const onPrimary = target?.environmentId === primaryEnvironmentId;
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
  }, [refresh]);

  const connect = useCallback(async () => {
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
        const next = await gmailRequest((client) =>
          client.integrations.gmailStatus({ headers: {} }),
        );
        setStatus(next);
        if (next.connected) break;
      }
    } catch {
      toastManager.add({
        type: "error",
        title: "Gmail connection failed",
        description: "Try connecting again.",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (
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
  }, [enabled, onPrimary, onHostComputer, status, connect]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await gmailRequest((client) => client.integrations.gmailDisconnect({ headers: {} }));
      await refresh();
    } catch {
      toastManager.add({ type: "error", title: "Couldn't disconnect Gmail" });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!enabled || !onPrimary) return null;
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
  if (status && !status.configured)
    return <span className="text-xs text-muted-foreground">Google sign-in needs app setup.</span>;
  if (!onHostComputer)
    return <span className="text-xs text-muted-foreground">Connect Gmail on this computer.</span>;
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void connect()}>
      {busy ? "Connecting…" : "Connect Gmail"}
    </Button>
  );
}

export function ConnectedToolsSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixedGmail = useScopedSettingsMixed(["enableGmailAccess"]);
  const mixedSpreadsheets = useScopedSettingsMixed(["enableLocalSpreadsheetAccess"]);
  const mixedPresentations = useScopedSettingsMixed(["enableLocalPresentationAccess"]);
  return (
    <SettingsSection id="connected-tools" title="Tools">
      <SettingsRow
        serverScoped
        settingKeys={["enableGmailAccess"]}
        mixed={mixedGmail}
        id="gmail-access"
        title="Gmail"
        description="Let tasks send email from your connected Google account when you request or approve the message in a task."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <GmailConnectionControl enabled={settings.enableGmailAccess} />
            <Switch
              aria-label="Gmail"
              mixed={mixedGmail}
              checked={mixedGmail ? false : settings.enableGmailAccess}
              onCheckedChange={(value) => update({ enableGmailAccess: value })}
            />
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["enableLocalSpreadsheetAccess"]}
        mixed={mixedSpreadsheets}
        id="spreadsheet-access"
        title="Spreadsheets"
        description="Let tasks inspect .xlsx files and edit existing cells in this Space. Files stay on this computer."
        control={
          <Switch
            aria-label="Spreadsheets"
            mixed={mixedSpreadsheets}
            checked={mixedSpreadsheets ? false : settings.enableLocalSpreadsheetAccess}
            onCheckedChange={(value) => update({ enableLocalSpreadsheetAccess: value })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["enableLocalPresentationAccess"]}
        mixed={mixedPresentations}
        id="presentation-access"
        title="Presentations"
        description="Let tasks inspect .pptx slides and edit exact text in this Space. Files stay on this computer."
        control={
          <Switch
            aria-label="Presentations"
            mixed={mixedPresentations}
            checked={mixedPresentations ? false : settings.enableLocalPresentationAccess}
            onCheckedChange={(value) => update({ enableLocalPresentationAccess: value })}
          />
        }
      />
    </SettingsSection>
  );
}
