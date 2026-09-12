import type {
  Automation,
  AutomationId,
  EnvironmentId,
  OrchestrationShellSnapshot,
  ScopedAutomationRef,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentCatalogState } from "./connections.ts";
import {
  arrayElementsEqual,
  automationKey,
  automationRefsEqual,
  parseAutomationKey,
} from "./entities.ts";
import type { EnvironmentAutomation } from "./models.ts";
import { scopeAutomation } from "./models.ts";

const EMPTY_AUTOMATIONS: ReadonlyArray<Automation> = Object.freeze([]);
const EMPTY_AUTOMATION_INDEX: ReadonlyMap<AutomationId, Automation> = new Map();

export function createEnvironmentAutomationAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const scopedAutomations = new WeakMap<Automation, Map<EnvironmentId, EnvironmentAutomation>>();
  const scopedAutomation = (environmentId: EnvironmentId, automation: Automation) => {
    let byEnvironment = scopedAutomations.get(automation);
    if (byEnvironment === undefined) {
      byEnvironment = new Map();
      scopedAutomations.set(automation, byEnvironment);
    }
    let value = byEnvironment.get(environmentId);
    if (value === undefined) {
      value = scopeAutomation(environmentId, automation);
      byEnvironment.set(environmentId, value);
    }
    return value;
  };

  const environmentAutomationsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<Automation> =>
        get(input.snapshotAtom(environmentId))?.automations ?? EMPTY_AUTOMATIONS,
    ).pipe(Atom.withLabel(`environment-automations:${environmentId}`)),
  );

  const environmentAutomationIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<AutomationId, Automation> => {
      const automations = get(environmentAutomationsAtom(environmentId));
      if (automations.length === 0) {
        return EMPTY_AUTOMATION_INDEX;
      }
      return new Map(automations.map((automation) => [automation.id, automation] as const));
    }).pipe(Atom.withLabel(`environment-automation-index:${environmentId}`)),
  );

  const environmentAutomationRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedAutomationRef> = [];
    return Atom.make((get) => {
      const next = get(environmentAutomationsAtom(environmentId)).map((automation) => ({
        environmentId,
        automationId: automation.id,
      }));
      if (automationRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-automation-refs:${environmentId}`));
  });

  const automationAtomFamily = Atom.family((key: string) => {
    const ref = parseAutomationKey(key);
    return Atom.make((get) => {
      const source =
        get(environmentAutomationIndexAtom(ref.environmentId)).get(ref.automationId) ?? null;
      return source === null ? null : scopedAutomation(ref.environmentId, source);
    }).pipe(Atom.withLabel(`environment-automation:${key}`));
  });

  let previousAutomationRefs: ReadonlyArray<ScopedAutomationRef> = [];
  const automationRefsAtom = Atom.make((get) => {
    const refs: ScopedAutomationRef[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      refs.push(...get(environmentAutomationRefsAtom(environmentId)));
    }
    if (automationRefsEqual(previousAutomationRefs, refs)) {
      return previousAutomationRefs;
    }
    previousAutomationRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-automation-refs"));

  let previousAutomations: ReadonlyArray<EnvironmentAutomation> = [];
  const automationsAtom = Atom.make((get) => {
    const next: EnvironmentAutomation[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      for (const automation of get(environmentAutomationsAtom(environmentId))) {
        next.push(scopedAutomation(environmentId, automation));
      }
    }
    if (arrayElementsEqual(previousAutomations, next)) {
      return previousAutomations;
    }
    previousAutomations = next;
    return next;
  }).pipe(Atom.withLabel("environment-automation-list"));

  return {
    environmentAutomationsAtom,
    environmentAutomationRefsAtom,
    automationRefsAtom,
    automationsAtom,
    automationAtom: (ref: ScopedAutomationRef) => automationAtomFamily(automationKey(ref)),
  };
}
