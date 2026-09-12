import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type CreateAutomationInput,
  type DeleteAutomationInput,
  type PauseAutomationInput,
  type ResumeAutomationInput,
  type RunAutomationNowInput,
  type UpdateAutomationInput,
  createAutomation,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  updateAutomation,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateAutomationInput,
  DeleteAutomationInput,
  PauseAutomationInput,
  ResumeAutomationInput,
  RunAutomationNowInput,
  UpdateAutomationInput,
} from "../operations/commands.ts";

export function createAutomationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { automationId: string } }) =>
      JSON.stringify([environmentId, input.automationId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:automation:create",
      execute: (input: CreateAutomationInput) => createAutomation(input),
      scheduler,
      concurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:automation:update",
      execute: (input: UpdateAutomationInput) => updateAutomation(input),
      scheduler,
      concurrency,
    }),
    pause: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:automation:pause",
      execute: (input: PauseAutomationInput) => pauseAutomation(input),
      scheduler,
      concurrency,
    }),
    resume: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:automation:resume",
      execute: (input: ResumeAutomationInput) => resumeAutomation(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:automation:delete",
      execute: (input: DeleteAutomationInput) => deleteAutomation(input),
      scheduler,
      concurrency,
    }),
    runNow: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:automation:run-now",
      execute: (input: RunAutomationNowInput) => runAutomationNow(input),
      scheduler,
      concurrency,
    }),
  };
}
