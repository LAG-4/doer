import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ComputerService, make, parseDoctorPermissions } from "./ComputerService.ts";

const ProcessRunnerMock = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: () => Effect.die("ComputerService test must not spawn subprocesses"),
});

const serviceLayer = (prefix: string) =>
  Layer.effect(ComputerService, make).pipe(
    Layer.provide(ProcessRunnerMock),
    Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provide(NodeServices.layer),
  );

describe("ComputerService approvals", () => {
  it.effect("round-trips the per-app allow list case-insensitively", () =>
    Effect.gen(function* () {
      const computers = yield* ComputerService;
      expect(yield* computers.allowedApps).toEqual([]);
      expect(yield* computers.isAllowed("TextEdit")).toBe(false);

      expect(yield* computers.allow("TextEdit")).toEqual(["TextEdit"]);
      expect(yield* computers.allow("textedit")).toEqual(["TextEdit"]);
      expect(yield* computers.isAllowed("TEXTEDIT")).toBe(true);

      expect(yield* computers.forget({ app: "TextEdit" })).toEqual([]);
      expect(yield* computers.isAllowed("TextEdit")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer("t3-computer-service-test-"))),
  );

  it.effect("clears every approval when forget omits the app", () =>
    Effect.gen(function* () {
      const computers = yield* ComputerService;
      yield* computers.allow("TextEdit");
      yield* computers.allow("Safari");
      expect(yield* computers.forget({})).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer("t3-computer-forget-test-"))),
  );

  it.effect("reports an uninstalled helper without spawning anything", () =>
    Effect.gen(function* () {
      const computers = yield* ComputerService;
      const state = yield* computers.status;
      expect(state.supported).toBe(true);
      expect(state.cliInstalled).toBe(false);
      expect(state.onboardingNeeded).toBe(true);
      expect(state.allowedApps).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer("t3-computer-status-test-"))),
  );

  it.effect("refuses observe for unapproved apps before touching the CLI", () =>
    Effect.gen(function* () {
      const computers = yield* ComputerService;
      const failure = yield* Effect.flip(computers.observe({ app: "Chess" }));
      expect(failure._tag).toBe("ComputerUseError");
      expect(failure.message).toContain('has not approved "Chess"');
    }).pipe(Effect.scoped, Effect.provide(serviceLayer("t3-computer-observe-test-"))),
  );
});

describe("parseDoctorPermissions", () => {
  it("reads granted and missing states", () => {
    expect(
      parseDoctorPermissions("Permissions: accessibility=granted, screenRecording=granted"),
    ).toEqual({ accessibility: true, screenRecording: true });
    expect(
      parseDoctorPermissions("Permissions: accessibility=missing, screenRecording=granted"),
    ).toEqual({ accessibility: false, screenRecording: true });
  });

  it("returns undefined when the output has no permission line", () => {
    expect(parseDoctorPermissions("Timed out waiting for agent to start.")).toBeUndefined();
    expect(parseDoctorPermissions("")).toBeUndefined();
  });
});
