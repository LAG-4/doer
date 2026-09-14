import * as NodeZlib from "node:zlib";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { FetchHttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ComputerToolchainInstallError,
  ensureComputerUse,
  isComputerUseInstalled,
  parseTarArchive,
  tarEntryTargetSegments,
} from "./ComputerToolchain.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const writeField = (header: Uint8Array, value: string, offset: number, length: number): void => {
  const bytes = textEncoder.encode(value);
  header.set(bytes.subarray(0, length), offset);
};

const writeOctal = (header: Uint8Array, value: number, offset: number, length: number): void => {
  writeField(header, value.toString(8).padStart(length - 1, "0"), offset, length);
};

interface TestTarEntry {
  readonly name: string;
  readonly typeflag: string;
  readonly mode?: number | undefined;
  readonly data?: Uint8Array | undefined;
  readonly prefix?: string | undefined;
  readonly linkname?: string | undefined;
}

const tarHeader = (entry: TestTarEntry, size: number): Uint8Array => {
  const header = new Uint8Array(512);
  writeField(header, entry.name, 0, 100);
  writeOctal(header, entry.mode ?? 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(32, 148, 156);
  header[156] = entry.typeflag.charCodeAt(0);
  if (entry.linkname !== undefined) writeField(header, entry.linkname, 157, 100);
  writeField(header, "ustar", 257, 6);
  writeField(header, "00", 263, 2);
  if (entry.prefix !== undefined) writeField(header, entry.prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeField(header, sum.toString(8).padStart(6, "0"), 148, 6);
  header[154] = 0;
  header[155] = 32;
  return header;
};

/** Minimal valid tar for the given entries, ending with two zero blocks. */
const buildTar = (entries: ReadonlyArray<TestTarEntry>): Uint8Array => {
  const parts: Array<Uint8Array> = [];
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    parts.push(tarHeader(entry, data.length));
    if (data.length > 0) {
      parts.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding > 0) parts.push(new Uint8Array(padding));
    }
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const gzip = (input: Uint8Array): Uint8Array => new Uint8Array(NodeZlib.gzipSync(input));

const fileEntry = (
  name: string,
  text: string,
  options?: { readonly mode?: number | undefined; readonly prefix?: string | undefined },
): TestTarEntry => ({
  name,
  typeflag: "0",
  mode: options?.mode ?? 0o644,
  data: textEncoder.encode(text),
  prefix: options?.prefix,
});

describe("parseTarArchive", () => {
  it("reads files, directories, and modes", () => {
    const entries = parseTarArchive(
      buildTar([
        { name: "package/docs/", typeflag: "5", mode: 0o755 },
        fileEntry("package/bin/ocu", "#!/usr/bin/env node\n"),
        {
          name: "package/dist/tool",
          typeflag: "0",
          mode: 0o755,
          data: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
        },
      ]),
    );
    expect(entries.map((entry) => [entry.name, entry.type, entry.mode.toString(8)])).toEqual([
      ["package/docs/", "directory", "755"],
      ["package/bin/ocu", "file", "644"],
      ["package/dist/tool", "file", "755"],
    ]);
    expect(textDecoder.decode(entries[1]!.data)).toBe("#!/usr/bin/env node\n");
    expect(entries[2]!.data).toEqual(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
  });

  it("resolves GNU longnames, pax path overrides, and ustar prefixes", () => {
    const longName = `package/dist/${"n".repeat(120)}.bin`;
    const entries = parseTarArchive(
      buildTar([
        { name: "./@LongLink", typeflag: "L", data: textEncoder.encode(`${longName}\0`) },
        fileEntry("truncated", "long"),
        {
          name: "ignored",
          typeflag: "x",
          data: textEncoder.encode("27 path=package/real-name.txt\n"),
        },
        fileEntry("placeholder", "pax"),
        fileEntry("tool", "prefixed", { prefix: "package/bin" }),
      ]),
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      longName,
      "package/real-name.txt",
      "package/bin/tool",
    ]);
  });

  it("skips symlinks without losing alignment", () => {
    const entries = parseTarArchive(
      buildTar([
        { name: "package/bin/link", typeflag: "2", linkname: "ocu" },
        fileEntry("package/bin/ocu", "after-link"),
      ]),
    );
    expect(entries.map((entry) => entry.name)).toEqual(["package/bin/ocu"]);
  });

  it("rejects truncated archives and corrupt checksums", () => {
    const valid = buildTar([fileEntry("package/bin/ocu", "launcher")]);
    // Cut inside the first entry's data block.
    expect(() => parseTarArchive(valid.subarray(0, 515))).toThrow(/Invalid helper archive/);
    const corrupt = new Uint8Array(valid);
    // Flip a header byte: the stored header checksum no longer matches.
    corrupt[10] = corrupt[10]! ^ 0xff;
    expect(() => parseTarArchive(corrupt)).toThrow(/Invalid helper archive/);
  });
});

describe("tarEntryTargetSegments", () => {
  it("maps package paths and skips anything unsafe or outside the package", () => {
    expect(tarEntryTargetSegments("package/bin/ocu")).toEqual(["bin", "ocu"]);
    expect(tarEntryTargetSegments("package/dist/Open Computer Use.app/tool")).toEqual([
      "dist",
      "Open Computer Use.app",
      "tool",
    ]);
    expect(tarEntryTargetSegments("package/")).toBeUndefined();
    expect(tarEntryTargetSegments("other/bin/ocu")).toBeUndefined();
    expect(tarEntryTargetSegments("/package/bin/ocu")).toBeUndefined();
    expect(tarEntryTargetSegments("package/../evil")).toBeUndefined();
    expect(tarEntryTargetSegments("package/a//b")).toBeUndefined();
    expect(tarEntryTargetSegments("package/a/./b")).toBeUndefined();
    expect(tarEntryTargetSegments("package/a\\b")).toBeUndefined();
    expect(tarEntryTargetSegments("package/C:/evil")).toBeUndefined();
  });
});

const testLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ProcessRunner.ProcessRunner, { run }),
    Layer.succeed(HostProcessPlatform, "darwin"),
    // Required in scope by the installer; stub fetchers never touch it.
    FetchHttpClient.layer,
  );

const npmMissingRunner: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
      }),
    }),
  );

const fakeNpmRunner =
  (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    onRun?: () => void,
  ): ProcessRunner.ProcessRunner["Service"]["run"] =>
  (input) =>
    Effect.gen(function* () {
      onRun?.();
      const prefixIndex = input.args.indexOf("--prefix");
      const stagingDir = input.args[prefixIndex + 1];
      if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
      const entry = path.join(stagingDir, "node_modules", "open-computer-use", "bin", "ocu");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
      yield* fs.writeFileString(entry, "#!/usr/bin/env node\n").pipe(Effect.orDie);
      return {
        stdout: "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    });

const minimalHelperTarball = (): Uint8Array =>
  gzip(
    buildTar([
      fileEntry("package/bin/ocu", "#!/usr/bin/env node\nconsole.log('ocu');\n"),
      {
        name: "package/dist/native-tool",
        typeflag: "0",
        mode: 0o755,
        data: textEncoder.encode("native-bytes"),
      },
      { name: "package/dist/", typeflag: "5", mode: 0o755 },
    ]),
  );

describe("ensureComputerUse", () => {
  it.effect("installs from the tarball without spawning npm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-tarball-" });
      let fetchCount = 0;
      const tarball = minimalHelperTarball();
      const fetcher = Effect.sync(() => {
        fetchCount += 1;
        return tarball;
      });
      const paths = yield* ensureComputerUse(baseDir, fetcher);
      expect(fetchCount).toBe(1);
      expect(yield* fs.readFileString(paths.entryPath)).toContain("console.log('ocu')");
      expect(yield* fs.readFileString(paths.sentinelPath)).toBe("0.3.5\n");
      expect(textDecoder.decode(yield* fs.readFile(paths.entryPath))).toContain("ocu");
      expect(
        yield* fs.readFileString(
          path.join(
            baseDir,
            "tools",
            "open-computer-use",
            "0.3.5",
            "node_modules",
            "open-computer-use",
            "dist",
            "native-tool",
          ),
        ),
      ).toBe("native-bytes");
      expect(yield* isComputerUseInstalled(baseDir)).toBe(true);
      // A completed install short-circuits before any download.
      yield* ensureComputerUse(baseDir, fetcher);
      expect(fetchCount).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(testLayer(() => Effect.die("tarball install must not spawn subprocesses"))),
    ),
  );

  it.effect("falls back to npm when the download fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-npm-" });
      let npmCalls = 0;
      const downloadFailure = new ComputerToolchainInstallError({
        tool: "open-computer-use",
        step: "downloading the helper",
        cause: "offline",
      });
      const paths = yield* ensureComputerUse(baseDir, Effect.fail(downloadFailure)).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: fakeNpmRunner(fs, yield* Path.Path, () => {
            npmCalls += 1;
          }),
        }),
      );
      expect(npmCalls).toBe(1);
      expect(yield* fs.readFileString(paths.entryPath)).toBe("#!/usr/bin/env node\n");
      expect(yield* isComputerUseInstalled(baseDir)).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(HostProcessPlatform, "darwin"),
          FetchHttpClient.layer,
        ),
      ),
    ),
  );

  it.effect("reports the download failure when npm is also missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-offline-" });
      const failure = yield* Effect.flip(
        ensureComputerUse(
          baseDir,
          Effect.fail(
            new ComputerToolchainInstallError({
              tool: "open-computer-use",
              step: "downloading the helper",
              cause: "offline",
            }),
          ),
        ),
      );
      expect(failure._tag).toBe("ComputerToolchainInstallError");
      expect(failure.step).toBe("downloading the helper automatically");
      expect(failure.message).not.toContain("npm");
      expect(yield* isComputerUseInstalled(baseDir)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer(npmMissingRunner))),
  );

  it.effect("surfaces npm exit failures after a failed download", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-npmfail-" });
      const failure = yield* Effect.flip(
        ensureComputerUse(
          baseDir,
          Effect.fail(
            new ComputerToolchainInstallError({
              tool: "open-computer-use",
              step: "downloading the helper",
              cause: "offline",
            }),
          ),
        ),
      );
      expect(failure._tag).toBe("ComputerToolchainInstallError");
      expect(failure.step).toBe("running npm install");
      expect(failure.exitCode).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(() =>
          Effect.succeed({
            stdout: "",
            stderr: "registry unreachable",
            code: ChildProcessSpawner.ExitCode(1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
        ),
      ),
    ),
  );
});
