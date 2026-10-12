// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeStream from "node:stream";
import { createTwoFilesPatch, diffLines } from "diff";
import ignore from "ignore";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";

const Manifest = Schema.Record(
  Schema.String,
  Schema.Struct({
    hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    mode: Schema.Number,
  }),
);
const decode = Schema.decodeSync(Schema.fromJsonString(Manifest));
const encode = Schema.encodeSync(Schema.fromJsonString(Manifest));
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const excluded = new Set([
  ".git",
  ".t3",
  ".doer",
  "node_modules",
  ".cache",
  "__pycache__",
  ".DS_Store",
]);

/** Content-addressed folder snapshots; no subprocess or Git installation required. */
export const make = (stateDir: string) =>
  Effect.sync(() => {
    const gates = new Map<string, Semaphore.Semaphore>();
    const cached = new Map<string, { stamp: string; hash: string }>();
    const storageDirectory = (cwd: string) =>
      Effect.tryPromise({
        try: async () =>
          NodePath.join(stateDir, "folder-history", hash(await NodeFSP.realpath(cwd))),
        catch: (cause) =>
          new VcsProcessExitError({
            operation: "FolderHistory.directory",
            command: "filesystem",
            cwd,
            exitCode: 1,
            detail: String(cause),
          }),
      });
    const run = <A>(cwd: string, action: (root: string, directory: string) => Promise<A>) =>
      storageDirectory(cwd).pipe(
        Effect.flatMap((directory) => {
          let gate = gates.get(directory);
          if (!gate) {
            gate = Semaphore.makeUnsafe(1);
            gates.set(directory, gate);
          }
          return gate.withPermit(
            Effect.tryPromise({
              try: async () => action(await NodeFSP.realpath(cwd), directory),
              catch: (cause) =>
                new VcsProcessExitError({
                  operation: "FolderHistory",
                  command: "filesystem",
                  cwd,
                  exitCode: 1,
                  detail: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
          );
        }),
      );
    const refPath = (directory: string, ref: string) =>
      NodePath.join(directory, "snapshots", `${hash(ref)}.json`);
    const blobPath = (directory: string, digest: string) =>
      NodePath.join(directory, "files", digest);
    const missing = (cause: unknown) =>
      cause instanceof Error && "code" in cause && cause.code === "ENOENT";
    const read = async (directory: string, ref: string) => {
      try {
        const manifest = decode(await NodeFSP.readFile(refPath(directory, ref), "utf8"));
        Object.setPrototypeOf(manifest, null);
        return manifest;
      } catch (cause) {
        if (missing(cause)) return null;
        throw cause;
      }
    };
    const atomic = async (target: string, contents: string) => {
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      const temp = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.writeFile(temp, contents, { mode: 0o600 });
        await NodeFSP.rename(temp, target);
      } finally {
        await NodeFSP.rm(temp, { force: true });
      }
    };
    const fileHash = async (file: string, directory?: string) => {
      const digest = NodeCrypto.createHash("sha256");
      if (!directory) {
        for await (const chunk of NodeFS.createReadStream(file)) digest.update(chunk);
        return digest.digest("hex");
      }
      await NodeFSP.mkdir(NodePath.join(directory, "files"), { recursive: true });
      const temp = NodePath.join(directory, "files", `${NodeCrypto.randomUUID()}.tmp`);
      try {
        await NodeStreamPromises.pipeline(
          NodeFS.createReadStream(file),
          new NodeStream.Transform({
            transform(chunk, _encoding, callback) {
              digest.update(chunk);
              callback(null, chunk);
            },
          }),
          NodeFS.createWriteStream(temp, { flags: "wx", mode: 0o600 }),
        );
        const result = digest.digest("hex");
        // Each blob is immutable. Concurrent captures produce identical bytes for the same hash.
        try {
          await NodeFSP.copyFile(temp, blobPath(directory, result), NodeFS.constants.COPYFILE_EXCL);
          await NodeFSP.chmod(blobPath(directory, result), 0o600);
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
        }
        return result;
      } finally {
        await NodeFSP.rm(temp, { force: true });
      }
    };
    const scan = async (root: string, directory: string, capture: boolean) => {
      const files: Record<string, (typeof Manifest.Type)[string]> = Object.create(null);
      await NodeFSP.mkdir(stateDir, { recursive: true });
      const stateRoot = await NodeFSP.realpath(stateDir);
      const walk = async (relative: string, rules: ReturnType<typeof ignore>) => {
        const folder = NodePath.join(root, relative);
        const localRules = ignore().add(rules);
        try {
          const lines = (await NodeFSP.readFile(NodePath.join(folder, ".gitignore"), "utf8")).split(
            /\r?\n/,
          );
          // Rules at each level apply to paths relative to that folder.
          localRules.add(
            lines.map((line) => {
              if (!relative || !line || line.startsWith("#")) return line;
              const negate = line.startsWith("!");
              const pattern = negate ? line.slice(1) : line;
              return `${negate ? "!" : ""}${relative}/${pattern.startsWith("/") ? pattern.slice(1) : pattern.includes("/") ? pattern : `**/${pattern}`}`;
            }),
          );
        } catch (cause) {
          if (!missing(cause)) throw cause;
        }
        for (const entry of await NodeFSP.readdir(folder, { withFileTypes: true })) {
          if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
          const rel = relative ? `${relative}/${entry.name}` : entry.name;
          const absolute = NodePath.join(root, rel);
          if (absolute === stateRoot || absolute.startsWith(`${stateRoot}${NodePath.sep}`))
            continue;
          if (localRules.ignores(`${rel}${entry.isDirectory() ? "/" : ""}`)) continue;
          if (entry.isDirectory()) await walk(rel, localRules);
          else if (entry.isFile()) {
            const stat = await NodeFSP.lstat(absolute, { bigint: true });
            const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
            const saved = capture ? cached.get(absolute) : undefined;
            const digest =
              saved?.stamp === stamp
                ? saved.hash
                : await fileHash(absolute, capture ? directory : undefined);
            if (capture) cached.set(absolute, { stamp, hash: digest });
            files[rel] = { hash: digest, mode: Number(stat.mode) & 0o777 };
          }
        }
      };
      await walk("", ignore());
      return files;
    };
    const safeTarget = async (root: string, relative: string) => {
      const target = NodePath.resolve(root, relative);
      const resolved = NodePath.relative(root, target);
      if (
        !resolved ||
        NodePath.isAbsolute(resolved) ||
        resolved === ".." ||
        resolved.startsWith(`..${NodePath.sep}`) ||
        resolved.split(NodePath.sep).some((part) => excluded.has(part))
      )
        throw new Error("History path must remain inside this folder.");
      // Never follow a newly created symlink while restoring an old snapshot.
      let current = root;
      for (const part of resolved.split(NodePath.sep)) {
        current = NodePath.join(current, part);
        try {
          if ((await NodeFSP.lstat(current)).isSymbolicLink())
            throw new Error("A History file was replaced by a link. It has been kept.");
        } catch (cause) {
          if (!missing(cause)) throw cause;
        }
      }
      return target;
    };
    const ops = {
      storageDirectory,
      captureCheckpoint: (input) =>
        run(input.cwd, async (root, directory) =>
          atomic(
            refPath(directory, input.checkpointRef),
            encode(await scan(root, directory, true)),
          ),
        ),
      hasCheckpointRef: (input) =>
        run(
          input.cwd,
          async (_root, directory) => (await read(directory, input.checkpointRef)) !== null,
        ),
      restoreCheckpoint: (input) =>
        run(input.cwd, async (root, directory) => {
          const target = await read(directory, input.checkpointRef);
          if (!target) return false;
          const current = await scan(root, directory, false);
          const paths = input.expectedPaths?.map((entry) => entry.path) ?? [
            ...new Set([...Object.keys(current), ...Object.keys(target)]),
          ];
          if (input.expectedPaths) {
            for (const entry of input.expectedPaths) {
              const expected = await read(directory, entry.checkpointRef);
              if (
                !expected ||
                current[entry.path]?.hash !== expected[entry.path]?.hash ||
                current[entry.path]?.mode !== expected[entry.path]?.mode
              )
                throw new Error(
                  "Some files changed after this Task finished. They have been kept. Undo the conversation without restoring files instead.",
                );
            }
          }
          // Validate all paths and blobs before changing any file.
          const targets = await Promise.all(
            paths.map(async (relative) => {
              const absolute = await safeTarget(root, relative);
              const saved = target[relative];
              if (saved) await NodeFSP.access(blobPath(directory, saved.hash));
              return { absolute, saved };
            }),
          );
          for (const { absolute, saved } of targets) {
            if (!saved) {
              await NodeFSP.rm(absolute, { force: true });
              cached.delete(absolute);
              continue;
            }
            await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
            const temp = `${absolute}.${NodeCrypto.randomUUID()}.tmp`;
            try {
              await NodeFSP.copyFile(blobPath(directory, saved.hash), temp);
              await NodeFSP.chmod(temp, saved.mode);
              await NodeFSP.rename(temp, absolute);
            } finally {
              await NodeFSP.rm(temp, { force: true });
              cached.delete(absolute);
            }
          }
          return true;
        }),
      diffCheckpoints: (input) =>
        run(input.cwd, async (_root, directory) => {
          const from = await read(directory, input.fromCheckpointRef);
          const to = await read(directory, input.toCheckpointRef);
          if (!from || !to) throw new Error("This History snapshot is unavailable.");
          let result = "";
          for (const relative of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
            if (
              from[relative]?.hash === to[relative]?.hash &&
              from[relative]?.mode === to[relative]?.mode
            )
              continue;
            const tooLarge =
              (from[relative] &&
                (await NodeFSP.stat(blobPath(directory, from[relative].hash))).size > 2_000_000) ||
              (to[relative] &&
                (await NodeFSP.stat(blobPath(directory, to[relative].hash))).size > 2_000_000);
            if (tooLarge) {
              result +=
                input.format === "numstat"
                  ? `-\t-\t${relative}\0`
                  : `diff --git ${JSON.stringify(`a/${relative}`)} ${JSON.stringify(`b/${relative}`)}\nBinary files a/${relative} and b/${relative} differ\n`;
              continue;
            }
            const before = from[relative]
              ? await NodeFSP.readFile(blobPath(directory, from[relative].hash))
              : Buffer.alloc(0);
            const after = to[relative]
              ? await NodeFSP.readFile(blobPath(directory, to[relative].hash))
              : Buffer.alloc(0);
            const binary = before.includes(0) || after.includes(0);
            const changes = binary
              ? []
              : diffLines(before.toString(), after.toString(), {
                  ignoreWhitespace: input.ignoreWhitespace,
                });
            if (input.format === "numstat")
              result += `${binary ? "-" : changes.filter((change) => change.added).reduce((sum, change) => sum + (change.count ?? 0), 0)}\t${binary ? "-" : changes.filter((change) => change.removed).reduce((sum, change) => sum + (change.count ?? 0), 0)}\t${relative}\0`;
            else
              result += `diff --git ${JSON.stringify(`a/${relative}`)} ${JSON.stringify(`b/${relative}`)}\n${binary ? `Binary files a/${relative} and b/${relative} differ\n` : createTwoFilesPatch(from[relative] ? `a/${relative}` : "/dev/null", to[relative] ? `b/${relative}` : "/dev/null", before.toString(), after.toString(), undefined, undefined, { ignoreWhitespace: input.ignoreWhitespace }).replace(/^=+\n/, "")}`;
          }
          return result;
        }),
      deleteCheckpointRefs: (input) =>
        run(input.cwd, async (_root, directory) => {
          for (const ref of input.checkpointRefs)
            await NodeFSP.rm(refPath(directory, ref), { force: true });
        }),
    } satisfies VcsCheckpointOps & { storageDirectory: typeof storageDirectory };
    return ops;
  });
