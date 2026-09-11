// @effect-diagnostics nodeBuiltinImport:off - Test-only path expectations need
// the same join semantics as the module under test.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  isDefaultOpenCodeBinary,
  openCodeArchiveExtractCommand,
  openCodeBinaryCandidates,
  openCodeCurlDownloadArgs,
  openCodeExtractedBinaryNames,
  openCodeInstallArchiveFilename,
  openCodeInstallDownloadUrl,
  openCodeInstallTargetForHost,
  openCodeManagedBinaryPath,
  openCodeManagedBinDir,
  openCodeManagedDir,
  openCodeManagedPackageJson,
  openCodeManagedScriptBinaryPath,
  openCodeManagedScriptBinDir,
  openCodeNativeBinaryPath,
  openCodeNpmInstallArgs,
  powershellSingleQuoted,
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
    expect(openCodeManagedScriptBinDir(managedDir)).toBe(
      NodePath.join("/t3home", "tools", "opencode", "bin"),
    );
    expect(openCodeManagedScriptBinaryPath(managedDir, "darwin")).toBe(
      NodePath.join("/t3home", "tools", "opencode", "bin", "opencode"),
    );
    expect(openCodeManagedScriptBinaryPath(managedDir, "win32")).toBe(
      NodePath.join("/t3home", "tools", "opencode", "bin", "opencode.exe"),
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
      NodePath.join("/t3home", "tools", "opencode", "bin", "opencode"),
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

  it("resolves release targets the way the official install script does", () => {
    expect(openCodeInstallTargetForHost({ platform: "darwin", arch: "arm64" })).toBe(
      "darwin-arm64",
    );
    expect(openCodeInstallTargetForHost({ platform: "darwin", arch: "x64" })).toBe("darwin-x64");
    expect(openCodeInstallTargetForHost({ platform: "linux", arch: "x64" })).toBe("linux-x64");
    expect(openCodeInstallTargetForHost({ platform: "linux", arch: "aarch64" })).toBe(
      "linux-arm64",
    );
    expect(openCodeInstallTargetForHost({ platform: "win32", arch: "x64" })).toBe("windows-x64");
    // The script ships no Windows ARM64 asset.
    expect(openCodeInstallTargetForHost({ platform: "win32", arch: "arm64" })).toBeNull();
    expect(openCodeInstallTargetForHost({ platform: "darwin", arch: "ia32" })).toBeNull();
  });

  it("builds release archive names and download URLs", () => {
    expect(openCodeInstallArchiveFilename("darwin-arm64")).toBe("opencode-darwin-arm64.zip");
    expect(openCodeInstallArchiveFilename("windows-x64")).toBe("opencode-windows-x64.zip");
    expect(openCodeInstallArchiveFilename("linux-x64")).toBe("opencode-linux-x64.tar.gz");
    expect(openCodeInstallDownloadUrl("darwin-arm64")).toBe(
      "https://github.com/sst/opencode/releases/latest/download/opencode-darwin-arm64.zip",
    );
  });

  it("builds a failing-loudly curl download command", () => {
    expect(openCodeCurlDownloadArgs("https://example.com/a.zip", "/tmp/a.zip")).toEqual([
      "-fsSL",
      "-L",
      "-o",
      "/tmp/a.zip",
      "https://example.com/a.zip",
    ]);
  });

  it("picks a preinstalled extractor per platform", () => {
    expect(
      openCodeArchiveExtractCommand({ platform: "linux", archivePath: "a.tgz", destDir: "d" }),
    ).toEqual({ command: "tar", args: ["-xzf", "a.tgz", "-C", "d"] });
    expect(
      openCodeArchiveExtractCommand({ platform: "darwin", archivePath: "a.zip", destDir: "d" }),
    ).toEqual({ command: "unzip", args: ["-q", "a.zip", "-d", "d"] });
    expect(
      openCodeArchiveExtractCommand({
        platform: "win32",
        archivePath: "C:\\tmp\\a.zip",
        destDir: "C:\\tmp\\d",
      }),
    ).toEqual({
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath 'C:\\tmp\\a.zip' -DestinationPath 'C:\\tmp\\d' -Force",
      ],
    });
  });

  it("quotes PowerShell paths and prefers platform binary names", () => {
    expect(powershellSingleQuoted("C:\\amy's dir")).toBe("'C:\\amy''s dir'");
    expect(openCodeExtractedBinaryNames("win32")).toEqual(["opencode.exe", "opencode"]);
    expect(openCodeExtractedBinaryNames("darwin")).toEqual(["opencode", "opencode.exe"]);
  });
});
