// @effect-diagnostics nodeBuiltinImport:off - Test-only path expectations need
// the same join semantics as the module under test.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  isDefaultOpenCodeBinary,
  openCodeBinaryCandidates,
  openCodeManagedBinaryPath,
  openCodeManagedBinDir,
  openCodeManagedDir,
  openCodeManagedPackageJson,
  openCodeNativeBinaryPath,
  openCodeNpmInstallArgs,
  resolveOpenCodeHome,
} from "./opencodeInstall.ts";

describe("opencodeInstall", () => {
  it("treats blank and stock binary paths as default", () => {
    expect(isDefaultOpenCodeBinary("opencode")).toBe(true);
    expect(isDefaultOpenCodeBinary("  opencode  ")).toBe(true);
    expect(isDefaultOpenCodeBinary("")).toBe(true);
    expect(isDefaultOpenCodeBinary(null)).toBe(true);
    expect(isDefaultOpenCodeBinary(undefined)).toBe(true);
    expect(isDefaultOpenCodeBinary("/usr/local/bin/opencode")).toBe(false);
    expect(isDefaultOpenCodeBinary("opencode-ai")).toBe(false);
  });

  it("derives the managed layout below the T3 home directory", () => {
    const managedDir = openCodeManagedDir("/t3home");
    expect(managedDir).toBe(NodePath.join("/t3home", "tools", "opencode"));
    expect(openCodeManagedBinDir(managedDir)).toBe(
      NodePath.join("/t3home", "tools", "opencode", "node_modules", ".bin"),
    );
    expect(openCodeManagedBinaryPath(managedDir, "darwin")).toBe(
      NodePath.join("/t3home", "tools", "opencode", "node_modules", ".bin", "opencode"),
    );
    expect(openCodeManagedBinaryPath(managedDir, "win32")).toBe(
      NodePath.join("/t3home", "tools", "opencode", "node_modules", ".bin", "opencode.cmd"),
    );
  });

  it("points at the official install script location", () => {
    expect(openCodeNativeBinaryPath("/home/amy", "linux")).toBe(
      NodePath.join("/home/amy", ".opencode", "bin", "opencode"),
    );
    expect(openCodeNativeBinaryPath("C:\\Users\\amy", "win32")).toBe(
      NodePath.join("C:\\Users\\amy", ".opencode", "bin", "opencode.exe"),
    );
  });

  it("prefers the environment home with an OS fallback", () => {
    expect(resolveOpenCodeHome({ HOME: "/home/amy" }, "linux")).toBe("/home/amy");
    expect(resolveOpenCodeHome({ USERPROFILE: "C:\\Users\\amy" }, "win32")).toBe("C:\\Users\\amy");
    expect(resolveOpenCodeHome({}, "linux")).toBeTypeOf("string");
  });

  it("orders default-binary candidates PATH-first, then native, then managed", () => {
    expect(
      openCodeBinaryCandidates({
        binaryPath: "opencode",
        environment: { HOME: "/home/amy" },
        managedDir: "/t3home/tools/opencode",
        platform: "linux",
      }),
    ).toEqual([
      "opencode",
      NodePath.join("/home/amy", ".opencode", "bin", "opencode"),
      NodePath.join("/t3home", "tools", "opencode", "node_modules", ".bin", "opencode"),
    ]);
  });

  it("skips locations without a directory configured", () => {
    expect(openCodeBinaryCandidates({ binaryPath: "opencode", platform: "linux" })).toHaveLength(2);
    expect(
      openCodeBinaryCandidates({
        binaryPath: "opencode",
        environment: { HOME: "/home/amy" },
        platform: "linux",
      }),
    ).toHaveLength(2);
  });

  it("returns custom binary paths verbatim", () => {
    expect(
      openCodeBinaryCandidates({
        binaryPath: "/usr/local/bin/opencode",
        environment: { HOME: "/home/amy" },
        managedDir: "/t3home/tools/opencode",
        platform: "linux",
      }),
    ).toEqual(["/usr/local/bin/opencode"]);
  });

  it("builds a scoped npm install command for the managed directory", () => {
    expect(openCodeNpmInstallArgs("/t3home/tools/opencode")).toEqual([
      "install",
      "--prefix",
      "/t3home/tools/opencode",
      "--allow-scripts=opencode-ai",
      "--no-audit",
      "--no-fund",
      "opencode-ai@latest",
    ]);
    const manifest = JSON.parse(openCodeManagedPackageJson()) as { name: string; private: boolean };
    expect(manifest.name).toBe("t3-managed-opencode");
    expect(manifest.private).toBe(true);
  });
});
