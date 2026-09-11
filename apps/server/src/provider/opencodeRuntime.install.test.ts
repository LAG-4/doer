import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { openCodeManagedBinaryPath } from "./opencodeInstall.ts";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

/** Executable stubInstalling `npm install --prefix <dir> …` results on every platform. */
const writeFakeNpm = Effect.fn("writeFakeNpm")(function* (input: {
  readonly binDir: string;
  readonly scriptPath: string;
  readonly nodeBinary: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly isWindows: boolean;
}) {
  const { binDir, scriptPath, nodeBinary, fs, path, isWindows } = input;
  yield* fs.writeFileString(
    scriptPath,
    [
      "const args = process.argv.slice(2);",
      'const prefixIndex = args.indexOf("--prefix");',
      "const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : null;",
      'if (args[0] !== "install" || !prefix) {',
      '  console.error(`unexpected npm stub args: ${args.join(" ")}`);',
      "  process.exit(2);",
      "}",
      'const fs = await import("node:fs");',
      'const path = await import("node:path");',
      'const binDir = path.join(prefix, "node_modules", ".bin");',
      "fs.mkdirSync(binDir, { recursive: true });",
      'const exe = path.join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");',
      'fs.writeFileSync(exe, process.platform === "win32" ? "@echo off\\r\\necho opencode-stub\\r\\n" : "#!/bin/sh\\necho opencode-stub\\n");',
      'if (process.platform !== "win32") fs.chmodSync(exe, 0o755);',
      "",
    ].join("\n"),
  );
  const launcher = path.join(binDir, isWindows ? "npm.cmd" : "npm");
  yield* fs.writeFileString(
    launcher,
    isWindows
      ? `@echo off\r\n"${nodeBinary}" "${scriptPath}" %*\r\n`
      : [`#!/bin/sh`, `exec "${nodeBinary}" "${scriptPath}" "$@"`, ""].join("\n"),
  );
  if (!isWindows) {
    yield* fs.chmod(launcher, 0o755);
  }
});

const writeFakeOpencode = Effect.fn("writeFakeOpencode")(function* (input: {
  readonly filePath: string;
  readonly fs: FileSystem.FileSystem;
  readonly isWindows: boolean;
}) {
  const { filePath, fs, isWindows } = input;
  yield* fs.writeFileString(
    filePath,
    isWindows
      ? "@echo off\r\necho opencode-fallback-ok\r\n"
      : "#!/bin/sh\necho opencode-fallback-ok\n",
  );
  if (!isWindows) {
    yield* fs.chmod(filePath, 0o755);
  }
});

it.layer(testLayer)("OpenCodeRuntime automatic install", (it) => {
  it.effect("returns an existing PATH binary without installing anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-install-" });
      const isWindows = hostPlatform === "win32";
      const binDir = path.join(tempDir, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* writeFakeOpencode({
        filePath: path.join(binDir, isWindows ? "opencode.cmd" : "opencode"),
        fs,
        isWindows,
      });
      const homeDir = path.join(tempDir, "home");
      yield* fs.makeDirectory(homeDir, { recursive: true });
      const managedDir = path.join(tempDir, "tools", "opencode");
      const environment = {
        ...hostEnvironment,
        PATH: binDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
      };

      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime.ensureOpenCodeInstalled({
        binaryPath: "opencode",
        managedDir,
        environment,
      });

      NodeAssert.equal(result.freshInstall, false);
      NodeAssert.equal(yield* fs.exists(managedDir), false);
    }),
  );

  it.effect("installs with npm when no binary is found anywhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const hostPlatform = yield* HostProcessPlatform;
      const executablePath = yield* HostProcessExecutablePath;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-install-" });
      const isWindows = hostPlatform === "win32";
      const binDir = path.join(tempDir, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      const npmScript = path.join(tempDir, "npm-stub.mjs");
      yield* writeFakeNpm({
        binDir,
        scriptPath: npmScript,
        nodeBinary: executablePath,
        fs,
        path,
        isWindows,
      });
      const homeDir = path.join(tempDir, "home");
      yield* fs.makeDirectory(homeDir, { recursive: true });
      const managedDir = path.join(tempDir, "tools", "opencode");
      const environment = {
        ...hostEnvironment,
        PATH: binDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
      };

      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime.ensureOpenCodeInstalled({
        binaryPath: "opencode",
        managedDir,
        environment,
      });

      NodeAssert.equal(result.freshInstall, true);
      NodeAssert.equal(result.binaryPath, openCodeManagedBinaryPath(managedDir, hostPlatform));
      NodeAssert.equal(yield* fs.exists(result.binaryPath), true);
    }),
  );

  it.effect("refuses to install over a custom binary path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-install-" });
      const homeDir = path.join(tempDir, "home");
      yield* fs.makeDirectory(homeDir, { recursive: true });
      const environment = { ...hostEnvironment, HOME: homeDir, USERPROFILE: homeDir };

      const runtime = yield* OpenCodeRuntime;
      const exit = yield* Effect.exit(
        runtime.ensureOpenCodeInstalled({
          binaryPath: "/custom/opencode",
          managedDir: path.join(tempDir, "tools", "opencode"),
          environment,
        }),
      );

      NodeAssert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("fails gracefully when npm is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-install-" });
      const emptyBin = path.join(tempDir, "empty-bin");
      yield* fs.makeDirectory(emptyBin, { recursive: true });
      const homeDir = path.join(tempDir, "home");
      yield* fs.makeDirectory(homeDir, { recursive: true });
      const environment = {
        ...hostEnvironment,
        PATH: emptyBin,
        HOME: homeDir,
        USERPROFILE: homeDir,
      };

      const runtime = yield* OpenCodeRuntime;
      const exit = yield* Effect.exit(
        runtime.ensureOpenCodeInstalled({
          binaryPath: "opencode",
          managedDir: path.join(tempDir, "tools", "opencode"),
          environment,
        }),
      );

      NodeAssert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("finds a script-installed binary outside PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-install-" });
      const isWindows = hostPlatform === "win32";
      const emptyBin = path.join(tempDir, "empty-bin");
      yield* fs.makeDirectory(emptyBin, { recursive: true });
      const homeDir = path.join(tempDir, "home");
      const nativeBinDir = path.join(homeDir, ".opencode", "bin");
      yield* fs.makeDirectory(nativeBinDir, { recursive: true });
      const nativeBinary = path.join(nativeBinDir, isWindows ? "opencode.exe" : "opencode");
      yield* writeFakeOpencode({ filePath: nativeBinary, fs, isWindows });
      const managedDir = path.join(tempDir, "tools", "opencode");
      const environment = {
        ...hostEnvironment,
        PATH: emptyBin,
        HOME: homeDir,
        USERPROFILE: homeDir,
      };

      const runtime = yield* OpenCodeRuntime;
      const ensured = yield* runtime.ensureOpenCodeInstalled({
        binaryPath: "opencode",
        managedDir,
        environment,
      });

      NodeAssert.equal(ensured.freshInstall, false);
      NodeAssert.equal(ensured.binaryPath, nativeBinary);
      NodeAssert.equal(yield* fs.exists(managedDir), false);
      if (!isWindows) {
        const result = yield* runtime.runOpenCodeCommand({
          binaryPath: "opencode",
          args: ["--version"],
          environment,
          managedDir,
        });
        NodeAssert.match(result.stdout, /opencode-fallback-ok/);
        NodeAssert.equal(result.code, 0);
      }
    }),
  );
});
