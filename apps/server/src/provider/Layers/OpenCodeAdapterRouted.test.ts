import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { OpenCodeRuntimeError, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { probeRoutedApiVersion } from "./OpenCodeAdapterRouted.ts";

const stubRuntime = (overrides: {
  readonly versionStdout?: string | null;
  readonly apiVersion?: 1 | 2 | null;
}): OpenCodeRuntimeShape =>
  ({
    runOpenCodeCommand: () =>
      overrides.versionStdout === null || overrides.versionStdout === undefined
        ? Effect.fail(
            new OpenCodeRuntimeError({
              operation: "runOpenCodeCommand",
              detail: "spawn opencode ENOENT",
            }),
          )
        : Effect.succeed({ stdout: overrides.versionStdout, stderr: "", code: 0 }),
    connectToOpenCodeServer: () =>
      overrides.apiVersion === null || overrides.apiVersion === undefined
        ? Effect.fail(
            new OpenCodeRuntimeError({
              operation: "server.info",
              detail: "connection refused",
            }),
          )
        : Effect.succeed({
            url: "http://127.0.0.1:4096",
            version: overrides.apiVersion === 2 ? "2.0.11" : "1.18.31",
            apiVersion: overrides.apiVersion,
            exitCode: null,
            external: true,
          }),
  }) as unknown as OpenCodeRuntimeShape;

const localInput = {
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
};

describe("probeRoutedApiVersion", () => {
  it.effect("routes a v1 CLI to the v1 adapter", () =>
    Effect.gen(function* () {
      const version = yield* probeRoutedApiVersion(
        stubRuntime({ versionStdout: "opencode 1.18.31\n" }),
        localInput,
      );
      NodeAssert.equal(version, 1);
    }),
  );

  it.effect("routes a v2 CLI to the v2 adapter", () =>
    Effect.gen(function* () {
      const version = yield* probeRoutedApiVersion(
        stubRuntime({ versionStdout: "opencode v2.0.11\n" }),
        localInput,
      );
      NodeAssert.equal(version, 2);
    }),
  );

  it.effect("prefers v2 when the local CLI is missing, v1 when its version is unparsable", () =>
    Effect.gen(function* () {
      NodeAssert.equal(
        yield* probeRoutedApiVersion(stubRuntime({ versionStdout: null }), localInput),
        2,
      );
      NodeAssert.equal(
        yield* probeRoutedApiVersion(stubRuntime({ versionStdout: "garbage" }), localInput),
        1,
      );
    }),
  );

  it.effect("follows the connected external server's API version", () =>
    Effect.gen(function* () {
      const external = {
        binaryPath: "opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "",
      };
      NodeAssert.equal(yield* probeRoutedApiVersion(stubRuntime({ apiVersion: 1 }), external), 1);
      NodeAssert.equal(yield* probeRoutedApiVersion(stubRuntime({ apiVersion: 2 }), external), 2);
    }),
  );

  it.effect("prefers v2 when the external server is unreachable", () =>
    Effect.gen(function* () {
      const external = {
        binaryPath: "opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "",
      };
      NodeAssert.equal(
        yield* probeRoutedApiVersion(stubRuntime({ apiVersion: null }), external),
        2,
      );
    }),
  );
});
