import { useRef, useState } from "react";
import { Switch } from "../ui/switch";
import { GmailConnectionControl } from "./GmailConnectionControl";
import { ComputerSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ConnectedToolsSettings() {
  return (
    <ComputerSettingsScope>
      <ConnectedToolsControls />
    </ComputerSettingsScope>
  );
}

function ConnectedToolsControls() {
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const [requestConnection, setRequestConnection] = useState(false);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const toggle = async (
    key: "enableGmailAccess" | "enableLocalSpreadsheetAccess" | "enableLocalPresentationAccess",
    value: boolean,
  ) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (await update({ [key]: value })) {
        if (key === "enableGmailAccess") setRequestConnection(value);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
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
        description={
          <>
            Search and read mail, organize existing labels, and send emails. Mail used in tasks may
            be sent to your chosen AI provider. Review each send and mailbox change before
            approving. One account is shared by your Spaces and trusted paired devices on this
            computer. Switches are shared with chat. Switching off pauses access; Disconnect
            switches Gmail off and removes Google access.{" "}
            <a
              className="underline"
              href="https://doer.lagaryan.click/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Privacy policy
            </a>
          </>
        }
        control={
          <Switch
            aria-label="Gmail"
            disabled={saving}
            mixed={mixedGmail}
            checked={mixedGmail ? false : settings.enableGmailAccess}
            onCheckedChange={(value) => void toggle("enableGmailAccess", value)}
          />
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
          <GmailConnectionControl
            key={target?.environmentId}
            environmentId={target?.environmentId ?? null}
            enabled={settings.enableGmailAccess}
            autoConnect={requestConnection}
            onConnectionAttempted={() => setRequestConnection(false)}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["enableLocalSpreadsheetAccess"]}
        mixed={mixedSpreadsheets}
        id="spreadsheet-access"
        title="Spreadsheets"
        description="Inspect .xlsx files and edit existing non-formula cells on the first sheet in this Space. Originals are backed up. File contents used in tasks may be sent to your chosen model."
        control={
          <Switch
            aria-label="Spreadsheets"
            disabled={saving}
            mixed={mixedSpreadsheets}
            checked={mixedSpreadsheets ? false : settings.enableLocalSpreadsheetAccess}
            onCheckedChange={(value) => void toggle("enableLocalSpreadsheetAccess", value)}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["enableLocalPresentationAccess"]}
        mixed={mixedPresentations}
        id="presentation-access"
        title="Presentations"
        description="Inspect .pptx slides and replace exact text in this Space. Originals are backed up. File contents used in tasks may be sent to your chosen model."
        control={
          <Switch
            aria-label="Presentations"
            disabled={saving}
            mixed={mixedPresentations}
            checked={mixedPresentations ? false : settings.enableLocalPresentationAccess}
            onCheckedChange={(value) => void toggle("enableLocalPresentationAccess", value)}
          />
        }
      />
    </SettingsSection>
  );
}
