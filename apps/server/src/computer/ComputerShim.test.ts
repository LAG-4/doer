// @effect-diagnostics nodeBuiltinImport:off - exercises the real launcher subprocess.
// @effect-diagnostics preferSchemaOverJson:off - asserts on raw launcher JSON passthrough.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ensureComputerShim } from "./ComputerShim.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

describe("computer-use launcher", () => {
  it.effect("enforces the per-app allow list and scrubs pointer overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-shim-" });
      const entryPath = path.join(dir, "ocu-stub.mjs");
      yield* fs.writeFileString(
        entryPath,
        `const args = process.argv.slice(2);
console.log(JSON.stringify({
  args,
  fallback: "OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS" in process.env,
  proxyKill: "OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY" in process.env,
}));`,
      );
      const allowlistPath = path.join(dir, "allowed-apps.json");
      const shim = yield* ensureComputerShim({ entryPath, stateDir: dir, allowlistPath });
      const launcher = platform === "win32" ? process.execPath : path.join(shim, "computer-use");
      const launcherArgs =
        platform === "win32" ? [path.join(shim, "computer-use-launcher.mjs")] : [];
      const invoke = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
        Effect.promise(() =>
          exec(launcher, [...launcherArgs, ...args], {
            env: {
              ...process.env,
              OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "1",
              OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY: "1",
              ...env,
            },
          }),
        );
      const expectInvokeFails = (args: ReadonlyArray<string>, text: string) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(invoke(args));
          expect(Exit.isFailure(exit)).toBe(true);
          const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
          expect(message).toContain(text);
        });

      // Read-only discovery passes with an empty allow list.
      for (const args of [["doctor"], ["list-apps"], ["call", "list_apps"], ["--help"]]) {
        const passed = JSON.parse((yield* invoke(args)).stdout) as { args: Array<string> };
        expect(passed.args).toEqual(args);
      }

      // Targeted actions are refused until the app is approved.
      yield* expectInvokeFails(
        ["call", "get_app_state", "--args", '{"app":"TextEdit"}'],
        "no approved apps",
      );
      yield* fs.writeFileString(allowlistPath, JSON.stringify({ version: 1, apps: ["TextEdit"] }));
      const observed = JSON.parse(
        (yield* invoke(["call", "get_app_state", "--args", '{"app":"TextEdit"}'])).stdout,
      ) as { args: Array<string>; fallback: boolean; proxyKill: boolean };
      expect(observed.args).toContain("get_app_state");
      // The pointer override and proxy kill switch never reach the helper.
      expect(observed.fallback).toBe(false);
      expect(observed.proxyKill).toBe(false);

      // Other apps stay denied, case-insensitively allowed ones pass.
      yield* expectInvokeFails(
        ["call", "click", "--args", '{"app":"Chess","element_index":"0"}'],
        'has not approved "Chess"',
      );
      const lower = JSON.parse((yield* invoke(["snapshot", "textedit"])).stdout) as {
        args: Array<string>;
      };
      expect(lower.args).toEqual(["snapshot", "textedit"]);

      // Sequenced calls gate every app in the batch.
      yield* expectInvokeFails(
        [
          "call",
          "--calls",
          JSON.stringify([
            { tool: "get_app_state", args: { app: "TextEdit" } },
            { tool: "type_text", args: { app: "Chess", text: "hi" } },
          ]),
        ],
        'has not approved "Chess"',
      );

      // Hosting the raw MCP server or installers bypasses the gate, so it is refused.
      yield* expectInvokeFails(["mcp"], "computer_* tools");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
