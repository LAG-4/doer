// @effect-diagnostics nodeBuiltinImport:off - Expected paths are asserted as
// literals; joining them here would test node:path against itself.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe as viteDescribe, expect as viteExpect, it as viteIt } from "vite-plus/test";

import { stripAnsiForDiagnostics } from "./opencodeRuntime.ts";
import {
  OPENCODE_XDG_DATA_HOME_VAR,
  ensureOpenCodeDataHome,
  openCodeDataNamespace,
  resolveOpenCodeDataHome,
  resolveOpenCodeShadowUsageRoots,
} from "./openCodeDataHome.ts";

viteDescribe("stripAnsiForDiagnostics", () => {
  viteIt("removes SGR color codes but keeps the message text", () => {
    viteExpect(
      stripAnsiForDiagnostics("[91m[1mError: [0mUnexpected error\n\nDatabase is empty"),
    ).toBe("Error: Unexpected error\n\nDatabase is empty");
  });

  viteIt("leaves plain text untouched", () => {
    viteExpect(stripAnsiForDiagnostics("plain message")).toBe("plain message");
  });

  viteIt("strips non-SGR control sequences too", () => {
    viteExpect(stripAnsiForDiagnostics("hide[?25lhere")).toBe("hidehere");
  });
});

viteDescribe("openCodeDataNamespace", () => {
  viteIt("keeps plain ids readable", () => {
    viteExpect(openCodeDataNamespace("opencode")).toBe("instance-opencode");
  });

  viteIt("keeps slash variants distinct without colliding", () => {
    viteExpect(openCodeDataNamespace("a/b")).not.toBe(openCodeDataNamespace("a_b"));
    viteExpect(openCodeDataNamespace("a/b")).toBe("instance-a%2Fb");
  });

  viteIt("neutralizes dot-dot so the namespace stays inside the data dir", () => {
    const namespace = openCodeDataNamespace("..");
    viteExpect(namespace).not.toContain("..");
    viteExpect(`/data/${namespace}`).toBe("/data/instance-%2E%2E");
  });

  viteIt("does not trim: trailing spaces stay distinct", () => {
    viteExpect(openCodeDataNamespace("a ")).not.toBe(openCodeDataNamespace("a"));
    viteExpect(openCodeDataNamespace("a ")).toBe("instance-a%20");
  });

  viteIt("escapes Windows-unfriendly colons", () => {
    viteExpect(openCodeDataNamespace("work:2")).toBe("instance-work%3A2");
  });
});

viteDescribe("resolveOpenCodeDataHome", () => {
  viteIt("honors an instance-configured XDG_DATA_HOME verbatim, spaces included", () => {
    viteExpect(
      resolveOpenCodeDataHome({
        instanceEnvironment: [{ name: OPENCODE_XDG_DATA_HOME_VAR, value: " /custom/my data " }],
        environment: { HOME: "/Users/someone" },
        managedDir: "/base/tools/opencode",
        instanceId: "opencode",
        platform: "darwin",
      }),
    ).toEqual({ dataHome: " /custom/my data ", globalDataDir: undefined, explicit: true });
  });

  viteIt("still isolates when only the ambient environment sets XDG_DATA_HOME", () => {
    viteExpect(
      resolveOpenCodeDataHome({
        instanceEnvironment: [],
        environment: { HOME: "/Users/someone", [OPENCODE_XDG_DATA_HOME_VAR]: "/ambient/xdg" },
        managedDir: "/base/tools/opencode",
        instanceId: "opencode",
        platform: "linux",
      }),
    ).toEqual({
      dataHome: "/base/tools/opencode/data/instance-opencode",
      globalDataDir: "/ambient/xdg",
      explicit: false,
    });
  });

  viteIt("defaults to a namespaced dir under the managed dir", () => {
    viteExpect(
      resolveOpenCodeDataHome({
        instanceEnvironment: undefined,
        environment: { HOME: "/Users/someone" },
        managedDir: "/base/tools/opencode",
        instanceId: "opencode",
        platform: "darwin",
      }),
    ).toEqual({
      dataHome: "/base/tools/opencode/data/instance-opencode",
      globalDataDir: "/Users/someone/.local/share",
      explicit: false,
    });
  });

  viteIt("scopes a second instance to its own namespace", () => {
    const resolution = resolveOpenCodeDataHome({
      instanceEnvironment: [],
      environment: { HOME: "/Users/someone" },
      managedDir: "/base/tools/opencode",
      instanceId: "opencode-work",
      platform: "linux",
    });
    viteExpect(resolution.dataHome).toBe("/base/tools/opencode/data/instance-opencode-work");
  });

  viteIt("resolves the global auth source from USERPROFILE on win32", () => {
    const resolution = resolveOpenCodeDataHome({
      instanceEnvironment: undefined,
      environment: { USERPROFILE: "C:\\Users\\someone" },
      managedDir: "C:\\base\\opencode",
      instanceId: "opencode",
      platform: "win32",
    });
    viteExpect(resolution.explicit).toBe(false);
    viteExpect(resolution.dataHome?.endsWith("instance-opencode")).toBe(true);
    viteExpect(resolution.globalDataDir?.endsWith(".local/share")).toBe(true);
  });
});

viteDescribe("resolveOpenCodeShadowUsageRoots", () => {
  viteIt("maps instances to their shadow data dirs with the same namespaces", () => {
    viteExpect(
      resolveOpenCodeShadowUsageRoots({
        managedDir: "/base/tools/opencode",
        instances: [
          { instanceId: "opencode", environment: [] },
          { instanceId: "../evil", environment: [] },
        ],
      }),
    ).toEqual([
      "/base/tools/opencode/data/instance-opencode/opencode",
      `/base/tools/opencode/data/${openCodeDataNamespace("../evil")}/opencode`,
    ]);
  });

  viteIt("prefers an instance-configured data location", () => {
    viteExpect(
      resolveOpenCodeShadowUsageRoots({
        managedDir: "/base/tools/opencode",
        instances: [
          {
            instanceId: "opencode",
            environment: [{ name: OPENCODE_XDG_DATA_HOME_VAR, value: "/custom/data" }],
          },
        ],
      }),
    ).toEqual(["/custom/data/opencode"]);
  });

  viteIt("always appends opencode, even when the XDG value ends with it", () => {
    viteExpect(
      resolveOpenCodeShadowUsageRoots({
        managedDir: "/base/tools/opencode",
        instances: [
          {
            instanceId: "opencode",
            environment: [{ name: OPENCODE_XDG_DATA_HOME_VAR, value: "/custom/data/opencode" }],
          },
        ],
      }),
    ).toEqual(["/custom/data/opencode/opencode"]);
  });

  viteIt("preserves raw spacing in configured roots like the runtime", () => {
    viteExpect(
      resolveOpenCodeShadowUsageRoots({
        managedDir: "/base/tools/opencode",
        instances: [
          {
            instanceId: "opencode",
            environment: [{ name: OPENCODE_XDG_DATA_HOME_VAR, value: " /custom/my data " }],
          },
        ],
      }),
    ).toEqual([" /custom/my data /opencode"]);
  });

  viteIt("scans the legacy usage override alongside the actual shadow root", () => {
    viteExpect(
      resolveOpenCodeShadowUsageRoots({
        managedDir: "/base/tools/opencode",
        instances: [
          {
            instanceId: "opencode",
            environment: [{ name: "OPENCODE_DATA_DIR", value: "/legacy/history" }],
          },
        ],
      }),
    ).toEqual(["/base/tools/opencode/data/instance-opencode/opencode", "/legacy/history"]);
  });
});

const makeTempDir = Effect.fn("openCodeDataHome.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

it.layer(NodeServices.layer)("openCodeDataHome.ensure", (it) => {
  describe("ensureOpenCodeDataHome", () => {
    it.effect("returns an explicit data home without touching the filesystem", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const missing = yield* makeTempDir("t3code-opencode-xdg-missing-").pipe(
          Effect.map((dir) => `${dir}-never-created`),
        );
        const returned = yield* ensureOpenCodeDataHome({
          dataHome: missing,
          globalDataDir: undefined,
          explicit: true,
        });
        expect(returned).toBe(missing);
        expect(yield* fileSystem.exists(missing)).toBe(false);
      }),
    );

    it.effect("copies the global auth.json with owner-only permissions", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir("t3code-opencode-home-");
        const managedDir = yield* makeTempDir("t3code-opencode-managed-");
        const globalAuthDir = path.join(home, ".local", "share", "opencode");
        yield* fileSystem.makeDirectory(globalAuthDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(globalAuthDir, "auth.json"),
          '{"type":"oauth"}',
        );
        // A live global database must be left alone: same bytes after ensure.
        const globalDb = path.join(globalAuthDir, "opencode.db");
        yield* fileSystem.writeFileString(globalDb, "global-db-bytes");

        const resolution = resolveOpenCodeDataHome({
          instanceEnvironment: [],
          environment: { HOME: home },
          managedDir,
          instanceId: "opencode",
          platform: "darwin",
        });
        expect(resolution.explicit).toBe(false);
        const dataHome = yield* ensureOpenCodeDataHome(resolution);
        expect(dataHome).toBe(path.join(managedDir, "data", "instance-opencode"));

        const shadowAuth = path.join(dataHome!, "opencode", "auth.json");
        expect(yield* fileSystem.readFileString(shadowAuth)).toBe('{"type":"oauth"}');
        const mode = (yield* fileSystem.stat(shadowAuth)).mode & 0o777;
        expect(mode).toBe(0o600);
        expect(yield* fileSystem.readFileString(globalDb)).toBe("global-db-bytes");
      }),
    );

    it.effect("imports auth from an ambient XDG_DATA_HOME source", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ambient = yield* makeTempDir("t3code-opencode-ambient-");
        const managedDir = yield* makeTempDir("t3code-opencode-managed-");
        const globalAuthDir = path.join(ambient, "opencode");
        yield* fileSystem.makeDirectory(globalAuthDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(globalAuthDir, "auth.json"),
          '{"type":"ambient"}',
        );

        const dataHome = yield* ensureOpenCodeDataHome(
          resolveOpenCodeDataHome({
            instanceEnvironment: [],
            environment: { HOME: "/nonexistent-home", [OPENCODE_XDG_DATA_HOME_VAR]: ambient },
            managedDir,
            instanceId: "opencode",
            platform: "linux",
          }),
        );
        expect(
          yield* fileSystem.readFileString(path.join(dataHome!, "opencode", "auth.json")),
        ).toBe('{"type":"ambient"}');
      }),
    );

    it.effect("never overwrites an existing shadow auth file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir("t3code-opencode-home-");
        const managedDir = yield* makeTempDir("t3code-opencode-managed-");
        const globalAuthDir = path.join(home, ".local", "share", "opencode");
        yield* fileSystem.makeDirectory(globalAuthDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(globalAuthDir, "auth.json"),
          '{"type":"global"}',
        );

        const dataHome = path.join(managedDir, "data", "instance-opencode");
        yield* fileSystem.makeDirectory(path.join(dataHome, "opencode"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(dataHome, "opencode", "auth.json"),
          '{"type":"shadow"}',
        );

        yield* ensureOpenCodeDataHome(
          resolveOpenCodeDataHome({
            instanceEnvironment: [],
            environment: { HOME: home },
            managedDir,
            instanceId: "opencode",
            platform: "darwin",
          }),
        );
        expect(yield* fileSystem.readFileString(path.join(dataHome, "opencode", "auth.json"))).toBe(
          '{"type":"shadow"}',
        );
      }),
    );

    it.effect("lets concurrent first-boots race safely", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir("t3code-opencode-home-");
        const managedDir = yield* makeTempDir("t3code-opencode-managed-");
        const globalAuthDir = path.join(home, ".local", "share", "opencode");
        yield* fileSystem.makeDirectory(globalAuthDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(globalAuthDir, "auth.json"),
          '{"type":"oauth"}',
        );

        const resolution = resolveOpenCodeDataHome({
          instanceEnvironment: [],
          environment: { HOME: home },
          managedDir,
          instanceId: "opencode",
          platform: "darwin",
        });
        const [first, second] = yield* Effect.all(
          [ensureOpenCodeDataHome(resolution), ensureOpenCodeDataHome(resolution)],
          { concurrency: "unbounded" },
        );
        expect(first).toBe(second);
        expect(yield* fileSystem.readFileString(path.join(first!, "opencode", "auth.json"))).toBe(
          '{"type":"oauth"}',
        );
      }),
    );

    it.effect("succeeds with no auth to preserve", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir("t3code-opencode-empty-home-");
        const managedDir = yield* makeTempDir("t3code-opencode-managed-");

        const dataHome = yield* ensureOpenCodeDataHome(
          resolveOpenCodeDataHome({
            instanceEnvironment: [],
            environment: { HOME: home },
            managedDir,
            instanceId: "opencode",
            platform: "darwin",
          }),
        );
        expect(dataHome).toBe(path.join(managedDir, "data", "instance-opencode"));
        expect(yield* fileSystem.exists(path.join(dataHome!, "opencode", "auth.json"))).toBe(false);
      }),
    );
  });
});
