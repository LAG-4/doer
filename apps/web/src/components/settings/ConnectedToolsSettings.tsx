import { Switch } from "../ui/switch";
import { GmailConnectionControl } from "./GmailConnectionControl";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ConnectedToolsSettings() {
  const { target } = useSettingsScope();
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
        description={
          <>
            Send-only Gmail access. Review the sender, recipients and full message before each send.
            One account is shared by your Spaces and trusted paired devices on this computer.
            Switching off pauses access; Disconnect removes Google access.{" "}
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            <GmailConnectionControl
              key={target?.environmentId}
              environmentId={target?.environmentId ?? null}
              enabled={settings.enableGmailAccess}
            />
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
        description="Inspect .xlsx files and edit existing non-formula cells on the first sheet in this Space. Originals are backed up. File contents used in tasks may be sent to your chosen model."
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
        description="Inspect .pptx slides and replace exact text in this Space. Originals are backed up. File contents used in tasks may be sent to your chosen model."
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
