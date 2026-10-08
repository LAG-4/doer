import { useClientSettings } from "~/hooks/useSettings";
import { isAdvancedSettingsItem } from "~/simpleMode";
import { useMemo } from "react";
import { AuthAccessWriteScope } from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { usePrimarySessionState } from "~/environments/primary";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
} from "./settingsSearch";
import { useExperimentalConnections } from "./useExperimentalConnections";

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const simple = useClientSettings((settings) => settings.simpleModeEnabled);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Host-scoped like the rows themselves: a selected machine reads its own
  // computer's switch, otherwise the primary one. Never mixes hosts. The
  // search scope carries a plain string, so resolve it to a known branded
  // environment id; a stale selection resolves to null (hide connections)
  // instead of the primary computer, which could expose the wrong host.
  const machine = scopeSearch.machine;
  const experimentalEnvironmentId =
    machine === undefined
      ? primaryEnvironmentId
      : (environments.find((environment) => environment.environmentId === machine)?.environmentId ??
        null);
  const { enabled: experimentalConnections } =
    useExperimentalConnections(experimentalEnvironmentId);
  const primarySessionState = usePrimarySessionState();
  const localEnvironmentDisabled = isLocalEnvironmentDisabled();
  const desktopWsl = useEnvironmentQuery(
    isElectron && !localEnvironmentDisabled ? desktopWslStateAtom : null,
  );
  const canManageLocalBackend =
    !localEnvironmentDisabled &&
    (isElectron ||
      ((primarySessionState.data?.authenticated &&
        primarySessionState.data.scopes?.includes(AuthAccessWriteScope)) ??
        false));

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        localEnvironmentDisabled,
        hasCloudPublicConfig: hasCloudPublicConfig(),
        hasEnvironment: environments.some((environment) => environment.serverConfig !== null),
        hasProviderSettingsEnvironment: environments.some((environment) =>
          isProviderSettingsEnvironmentAvailable({
            connectionPhase: environment.connection.phase,
            hasServerConfig: environment.serverConfig !== null,
          }),
        ),
        hasMacProviderSettingsEnvironment: environments.some(
          (environment) =>
            (scopeSearch.machine === undefined ||
              environment.environmentId === scopeSearch.machine) &&
            environment.serverConfig?.environment.platform.os === "darwin" &&
            isProviderSettingsEnvironmentAvailable({
              connectionPhase: environment.connection.phase,
              hasServerConfig: true,
            }),
        ),
        canManageLocalBackend,
        isWslSettingsRowVisible: isWslSettingsRowVisible({
          state: desktopWsl.data,
          error: desktopWsl.error,
        }),
        hasThreadAutoSettlement:
          getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0,
        hasExperimentalConnections: experimentalConnections === true,
      }).filter((item) => !simple || !isAdvancedSettingsItem(item)),
    [
      simple,
      canManageLocalBackend,
      desktopWsl.data,
      desktopWsl.error,
      environments,
      experimentalConnections,
      localEnvironmentDisabled,
      scopeSearch.machine,
    ],
  );
}
