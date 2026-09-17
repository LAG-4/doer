import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { isInboxWorkspaceRoot, resolveInboxRoot } from "./InboxWorkspace.ts";

it.effect("resolves the inbox root under Documents", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.strictEqual(
      resolveInboxRoot("/Users/someone", path),
      path.join("/Users/someone", "Documents", "Doer"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("matches the inbox workspace root after normalization", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const inboxRoot = resolveInboxRoot("/Users/someone", path);
    assert.isTrue(isInboxWorkspaceRoot(path.join(inboxRoot, "..", "Doer"), inboxRoot, path));
    assert.isFalse(
      isInboxWorkspaceRoot(path.join("/Users/someone", "Documents", "Codex"), inboxRoot, path),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
