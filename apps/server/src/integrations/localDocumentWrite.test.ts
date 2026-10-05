// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { replaceLocalDocument } from "./localDocumentWrite.ts";

let directory: string;
const original = Buffer.from("original document bytes");
const hash = NodeCrypto.createHash("sha256").update(original).digest("hex");
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "doer-document-write-"));
  await NodeFSP.writeFile(NodePath.join(directory, "sheet.xlsx"), original);
});
afterEach(async () => {
  const resolved = await NodeFSP.realpath(directory);
  const tempRoot = await NodeFSP.realpath(NodeOS.tmpdir());
  if (
    NodePath.dirname(resolved) !== tempRoot ||
    !NodePath.basename(resolved).startsWith("doer-document-write-")
  )
    throw new Error("Unexpected test cleanup NodePath");
  await NodeFSP.rm(resolved, { recursive: true, force: true });
});

describe("local document saves", () => {
  it("rejects a linked document without changing either copy", async () => {
    await NodeFSP.link(
      NodePath.join(directory, "sheet.xlsx"),
      NodePath.join(directory, "linked.xlsx"),
    );
    await expect(
      replaceLocalDocument({
        cwd: directory,
        relativePath: "sheet.xlsx",
        expectedSha256: hash,
        contents: Buffer.from("model edit"),
      }),
    ).rejects.toThrow("linked copies");
    expect(await NodeFSP.readFile(NodePath.join(directory, "linked.xlsx"))).toEqual(original);
  });
  it("atomically replaces a document and preserves a restorable original", async () => {
    const contents = Buffer.from("edited document bytes");
    const result = await replaceLocalDocument({
      cwd: directory,
      relativePath: "sheet.xlsx",
      expectedSha256: hash,
      contents,
    });
    expect(await NodeFSP.readFile(NodePath.join(directory, "sheet.xlsx"))).toEqual(contents);
    expect(await NodeFSP.readFile(NodePath.join(directory, result.backupPath))).toEqual(original);
    expect((await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("does not overwrite changes made since inspection", async () => {
    await NodeFSP.writeFile(NodePath.join(directory, "sheet.xlsx"), "new user edit");
    await expect(
      replaceLocalDocument({
        cwd: directory,
        relativePath: "sheet.xlsx",
        expectedSha256: hash,
        contents: Buffer.from("model edit"),
      }),
    ).rejects.toThrow("File changed");
    expect(await NodeFSP.readFile(NodePath.join(directory, "sheet.xlsx"), "utf8")).toBe(
      "new user edit",
    );
  });
  it("rejects paths outside the Space before writing", async () => {
    await expect(
      replaceLocalDocument({
        cwd: directory,
        relativePath: "../outside.xlsx",
        expectedSha256: hash,
        contents: original,
      }),
    ).rejects.toThrow("inside this Space");
  });
});
