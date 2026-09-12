import { assert, it } from "@effect/vitest";

import { formatCliCommand } from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/doer-cli/dist/bin.mjs", "npx doer-cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\doer-cli\\dist\\bin.mjs",
      "npx doer-cli serve",
    ],
    [
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/doer-cli/dist/bin.mjs",
      "pnpm dlx doer-cli serve",
    ],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/doer-cli/dist/bin.mjs",
      "pnpm dlx doer-cli serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\doer-cli\\dist\\bin.mjs",
      "pnpm dlx doer-cli serve",
    ],
    ["/home/theo/.bun/install/cache/doer-cli@0.0.31/dist/bin.mjs", "bunx doer-cli serve"],
    ["/tmp/bunx-1000-doer-cli@latest/node_modules/doer-cli/dist/bin.mjs", "bunx doer-cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-doer-cli@latest\\node_modules\\doer-cli\\dist\\bin.mjs",
      "bunx doer-cli serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/doer-cli/dist/bin.mjs",
    "/home/theo/Code/work/doer-fork/apps/server/dist/bin.mjs",
    "/home/theo/.t3/runtime/0.0.31/node_modules/doer-cli/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "doer serve",
    );
  }
});

it("re-suggests the nightly channel only for nightly builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx doer-cli@nightly serve"],
    ["0.0.31", "npx doer-cli serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/doer-cli/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/doer-cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx doer-cli@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-doer-cli@latest/node_modules/doer-cli/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx doer-cli serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/doer-cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "doer serve",
  );
});
