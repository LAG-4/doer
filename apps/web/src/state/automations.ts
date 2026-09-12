import { useAtomValue } from "@effect/atom-react";
import { createAutomationEnvironmentAtoms } from "@t3tools/client-runtime/state/automationCommands";
import { createEnvironmentAutomationAtoms } from "@t3tools/client-runtime/state/automations";
import type { EnvironmentAutomation } from "@t3tools/client-runtime/state/models";
import type { Automation, EnvironmentId, ScopedAutomationRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "./shell";

export const automationEnvironment = createAutomationEnvironmentAtoms(connectionAtomRuntime);

const environmentAutomations = createEnvironmentAutomationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_AUTOMATION_ATOM = Atom.make<EnvironmentAutomation | null>(null).pipe(
  Atom.withLabel("web-automation:empty"),
);
const EMPTY_AUTOMATIONS_ATOM = Atom.make<ReadonlyArray<Automation>>([]).pipe(
  Atom.withLabel("web-automations:empty"),
);

export function useAutomations(): ReadonlyArray<EnvironmentAutomation> {
  return useAtomValue(environmentAutomations.automationsAtom);
}

export function useEnvironmentAutomations(
  environmentId: EnvironmentId | null,
): ReadonlyArray<Automation> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_AUTOMATIONS_ATOM
      : environmentAutomations.environmentAutomationsAtom(environmentId),
  );
}

export function useAutomation(ref: ScopedAutomationRef | null): EnvironmentAutomation | null {
  return useAtomValue(
    ref === null ? EMPTY_AUTOMATION_ATOM : environmentAutomations.automationAtom(ref),
  );
}

export function readAutomations(): ReadonlyArray<EnvironmentAutomation> {
  return appAtomRegistry.get(environmentAutomations.automationsAtom);
}
