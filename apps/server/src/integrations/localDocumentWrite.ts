// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, targetPath: string) => {
  const relative = NodePath.relative(root, targetPath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

/** Save to a sibling, preserve the original, then atomically replace the document. */
export async function replaceLocalDocument(input: {
  cwd: string;
  relativePath: string;
  expectedSha256: string;
  contents: Uint8Array;
}): Promise<{ backupPath: string }> {
  const root = await NodeFSP.realpath(input.cwd);
  const requested = NodePath.resolve(root, input.relativePath);
  if (!inside(root, requested)) throw new Error("Choose a file inside this Space.");
  const target = await NodeFSP.realpath(requested);
  if (!inside(root, target) || (await NodeFSP.lstat(requested)).isSymbolicLink()) {
    throw new Error("Choose a regular document inside this Space.");
  }
  const original = await NodeFSP.readFile(target);
  if (hash(original) !== input.expectedSha256)
    throw new Error("File changed since inspection. Inspect it again.");
  const info = await NodeFSP.stat(target);
  if (!info.isFile() || info.nlink !== 1)
    throw new Error("Choose a regular document with no linked copies.");
  const backupDirectory = NodePath.join(root, ".doer-backups");
  await NodeFSP.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  if ((await NodeFSP.realpath(backupDirectory)) !== backupDirectory)
    throw new Error("The backup folder must be inside this Space without a link.");
  const backupPath = NodePath.join(
    backupDirectory,
    `${NodeCrypto.randomUUID()}-${NodePath.basename(target)}`,
  );
  const temporary = NodePath.join(NodePath.dirname(target), `.doer-${NodeCrypto.randomUUID()}.tmp`);
  try {
    const file = await NodeFSP.open(temporary, "wx", info.mode & 0o777);
    try {
      await file.writeFile(input.contents);
      await file.sync();
    } finally {
      await file.close();
    }
    // Recheck after editing and flushing so external changes during an edit are detected.
    if (
      (await NodeFSP.realpath(requested)) !== target ||
      hash(await NodeFSP.readFile(target)) !== input.expectedSha256
    ) {
      throw new Error("File changed while editing. Inspect it again.");
    }
    const backup = await NodeFSP.open(backupPath, "wx", 0o600);
    try {
      await backup.writeFile(original);
      await backup.sync();
    } finally {
      await backup.close();
    }
    await NodeFSP.rename(temporary, target);
    return { backupPath: NodePath.relative(root, backupPath).split(NodePath.sep).join("/") };
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
