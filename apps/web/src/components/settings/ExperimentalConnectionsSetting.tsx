import { EXPERIMENTAL_CONNECTIONS_COPY } from "@t3tools/shared/experimentalConnections";

import { useExperimentalConnections } from "./useExperimentalConnections";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

/**
 * The single master switch for Google, Microsoft, and local Office
 * connections. Always visible: when off, the connections below stay hidden
 * and their tools refuse with guidance, while disconnect stays available.
 */
export function ExperimentalConnectionsSetting() {
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const { enabled, error, errorKind, saving, setEnabled, refresh } =
    useExperimentalConnections(environmentId);
  return (
    <SettingsSection id="experimental-connections" title="Experimental connections">
      <SettingsRow
        serverScoped
        {...searchableSetting("experimental-connections")}
        id="experimental-connections"
        title={EXPERIMENTAL_CONNECTIONS_COPY.title}
        description={EXPERIMENTAL_CONNECTIONS_COPY.description}
        status={
          error !== null ? (
            <span className="flex max-w-prose flex-wrap items-center gap-2">
              <span role="alert" className="min-w-0 flex-1 text-destructive">
                {errorKind === "load" ? error : `${error} Your change was not saved.`}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={environmentId === null}
                onClick={() => refresh()}
              >
                Retry
              </Button>
            </span>
          ) : enabled === false ? (
            <span className="max-w-prose">
              {EXPERIMENTAL_CONNECTIONS_COPY.offHint} Disconnecting a connected account below still
              works while this is off.
            </span>
          ) : null
        }
        control={
          <Switch
            aria-label={EXPERIMENTAL_CONNECTIONS_COPY.title}
            disabled={saving || environmentId === null || enabled === null}
            checked={enabled === true}
            onCheckedChange={(value) => void setEnabled(value)}
          />
        }
      />
    </SettingsSection>
  );
}
