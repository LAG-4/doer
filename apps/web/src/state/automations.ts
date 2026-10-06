import { useAtomValue } from "@effect/atom-react";
import { createAutomationEnvironmentAtoms } from "@t3tools/client-runtime/state/automationCommands";
import { createEnvironmentAutomationAtoms } from "@t3tools/client-runtime/state/automations";
import type { EnvironmentAutomation } from "@t3tools/client-runtime/state/models";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const automationEnvironment = createAutomationEnvironmentAtoms(connectionAtomRuntime);

const environmentAutomations = createEnvironmentAutomationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

export function useAutomations(): ReadonlyArray<EnvironmentAutomation> {
  return useAtomValue(environmentAutomations.automationsAtom);
}
