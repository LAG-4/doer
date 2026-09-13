// @effect-diagnostics preferSchemaOverJson:off - JSON string literals embed paths safely into generated JavaScript.
/**
 * A directory holding a `computer-use` launcher that runs the pinned
 * `open-computer-use` install with the server's Node. Prepended to provider
 * subprocess PATHs so the agent types `computer-use …` and gets the version
 * the injected instructions were written for, regardless of what is or is
 * not globally installed.
 *
 * Unlike a bare passthrough, the launcher enforces the user's per-app allow
 * list (Codex's per-app prompt / "Always allow") for CLI-direct calls too:
 * any `call`/`snapshot` naming an app the user did not approve is refused
 * with instructions to get approval first. Read-only discovery (`list-apps`,
 * `doctor`, `help`) always passes through.
 *
 * The launcher also scrubs the process-level pointer override
 * (`OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS`) and the app-agent
 * proxy kill switch (`OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY`) so every
 * agent-driven action keeps the Codex default: the real pointer never moves,
 * and macOS automation keeps running under the helper app's identity.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SHIM_DIR = "computer/bin";

export const COMPUTER_USE_COMMAND = "computer-use";

export const ensureComputerShim = Effect.fn("ComputerShim.ensure")(function* (input: {
  readonly entryPath: string;
  readonly stateDir: string;
  readonly allowlistPath: string;
}) {
  const { entryPath, allowlistPath } = input;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const shimDir = path.join(input.stateDir, SHIM_DIR);
  yield* fs.makeDirectory(shimDir, { recursive: true });
  const node = process.execPath;
  const launcherPath = path.join(shimDir, "computer-use-launcher.mjs");
  yield* fs.writeFileString(
    launcherPath,
    `import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const entryPath = ${JSON.stringify(entryPath)};
const allowlistPath = ${JSON.stringify(allowlistPath)};
const fail = (message) => { console.error(message); process.exit(1); };
const readAllowlist = () => {
  try {
    if (!existsSync(allowlistPath)) return [];
    const parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
    const apps = Array.isArray(parsed?.apps) ? parsed.apps : [];
    return apps.filter((app) => typeof app === "string").map((app) => app.trim().toLowerCase()).filter(Boolean);
  } catch { return []; }
};
const isAllowed = (app, allowed) => {
  const wanted = String(app ?? "").trim().toLowerCase();
  return wanted.length > 0 && allowed.includes(wanted);
};
const readJsonArg = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
};
const appsFromCallArgs = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return typeof value.app === "string" ? [value.app] : [];
  }
  return [];
};
const targetsFor = (args) => {
  const [command, ...rest] = args;
  if (command === "snapshot") {
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    return positional.length > 0 ? [positional[positional.length - 1]] : [];
  }
  if (command !== "call") return [];
  if (rest[0] === "--calls" || rest[0] === "--calls-file") {
    const raw = rest[0] === "--calls" ? rest[1] : readJsonArg(rest[1]);
    const calls = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
    if (!Array.isArray(calls)) return [];
    return calls.flatMap((item) => appsFromCallArgs(item?.args));
  }
  const tool = rest[0];
  if (!tool || tool.startsWith("-")) return [];
  if (tool === "list_apps") return [];
  const flagIndex = rest.findIndex((arg) => arg === "--args" || arg === "--args-file");
  if (flagIndex < 0) return [];
  const raw = rest[flagIndex] === "--args" ? rest[flagIndex + 1] : readJsonArg(rest[flagIndex + 1]);
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return undefined; } })() : raw;
  return appsFromCallArgs(parsed);
};
const main = () => {
  const args = process.argv.slice(2);
  const [command] = args;
  const informational = args.length <= 2 && (
    command === undefined ||
    ["help", "--help", "-h", "version", "--version", "-v", "doctor", "list-apps", "turn-ended"].includes(command)
  );
  if (!informational && (command === "mcp" || (typeof command === "string" && command.startsWith("install-")))) {
    fail("Run computer-use through Doer's computer_* tools instead of hosting its MCP server or installers directly.");
  }
  if (!informational) {
    const allowed = readAllowlist();
    const targets = targetsFor(args);
    // Calls without an app target (list_apps, doctor-style discovery, or
    // malformed calls the helper itself rejects) always pass through; the
    // gate only guards actions on real apps.
    if (targets.length > 0) {
      if (allowed.length === 0) {
        fail("Computer use has no approved apps yet. Call computer_start first, ask the user which app to operate, then call computer_allow for it.");
      }
      const denied = targets.find((app) => !isAllowed(app, allowed));
      if (denied !== undefined) {
        fail('The user has not approved "' + denied + '" yet. Ask them for permission to see and operate it, and when they agree, call computer_allow for "' + denied + '" first. Never drive an app the user did not approve.');
      }
    }
  }
  const env = { ...process.env };
  delete env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS;
  delete env.OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY;
  const child = spawn(${JSON.stringify(node)}, [entryPath, ...args], { stdio: "inherit", env });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
};
main();
`,
  );
  if (platform === "win32") {
    const script = `@echo off\r\n"${node}" "${launcherPath}" %*\r\n`;
    yield* fs.writeFileString(path.join(shimDir, `${COMPUTER_USE_COMMAND}.cmd`), script);
  } else {
    const command = [node, launcherPath]
      .map((value) => "'" + value.replaceAll("'", "'\"'\"'") + "'")
      .join(" ");
    const script = `#!/bin/sh\nexec ${command} "$@"\n`;
    const shimPath = path.join(shimDir, COMPUTER_USE_COMMAND);
    yield* fs.writeFileString(shimPath, script);
    yield* fs.chmod(shimPath, 0o755);
  }
  return shimDir;
});
