import * as NodeAssert from "node:assert/strict";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, it } from "vite-plus/test";

import {
  buildOpenCodeV2PermissionRules,
  isOpenCodeAgentNotFoundError,
  isOpenCodeV2Version,
  loadOpenCodeV2Inventory,
  matchKnownAgentName,
  OpenCodeRuntimeError,
  type OpenCodeV2Client,
  parseServerPasswordFromOutput,
  parseServerUrlFromOutput,
} from "./opencodeRuntime.ts";

describe("parseServerUrlFromOutput", () => {
  it("accepts the v1 startup line", () => {
    NodeAssert.equal(
      parseServerUrlFromOutput("opencode server listening on http://127.0.0.1:4096\n"),
      "http://127.0.0.1:4096",
    );
  });

  it("accepts the v2 startup line", () => {
    NodeAssert.equal(
      parseServerUrlFromOutput("server listening on http://127.0.0.1:4096\n"),
      "http://127.0.0.1:4096",
    );
  });

  it("ignores unrelated output", () => {
    NodeAssert.equal(parseServerUrlFromOutput("listening on nothing\n"), null);
  });
});

describe("parseServerPasswordFromOutput", () => {
  it("captures the v2 auto-generated password", () => {
    NodeAssert.equal(
      parseServerPasswordFromOutput(
        "server listening on http://127.0.0.1:4096\nserver password s3cret\n",
      ),
      "s3cret",
    );
  });

  it("returns null when no password line was printed", () => {
    NodeAssert.equal(
      parseServerPasswordFromOutput("opencode server listening on http://127.0.0.1:4096\n"),
      null,
    );
  });

  it("keeps the last password when several are printed", () => {
    NodeAssert.equal(
      parseServerPasswordFromOutput("server password first\nserver password second\n"),
      "second",
    );
  });
});

describe("isOpenCodeV2Version", () => {
  it("routes major version 2 and above to the v2 API", () => {
    NodeAssert.equal(isOpenCodeV2Version("2.0.0"), true);
    NodeAssert.equal(isOpenCodeV2Version("2.0.11"), true);
    NodeAssert.equal(isOpenCodeV2Version("1.18.31"), false);
    NodeAssert.equal(isOpenCodeV2Version("not-a-version"), false);
  });
});

describe("isOpenCodeAgentNotFoundError", () => {
  it("matches the server's unknown-agent rejection", () => {
    NodeAssert.equal(
      isOpenCodeAgentNotFoundError(
        new OpenCodeRuntimeError({
          operation: "session.create",
          detail: 'Agent not found: "Build"',
        }),
      ),
      true,
    );
    NodeAssert.equal(isOpenCodeAgentNotFoundError(new Error("Agent not found: build")), true);
  });

  it("ignores unrelated failures", () => {
    NodeAssert.equal(
      isOpenCodeAgentNotFoundError(
        new OpenCodeRuntimeError({ operation: "session.get", detail: "Session not found" }),
      ),
      false,
    );
    NodeAssert.equal(isOpenCodeAgentNotFoundError(new Error("boom")), false);
  });
});

describe("matchKnownAgentName", () => {
  const known = [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ];

  it("passes exact execution ids through", () => {
    NodeAssert.equal(matchKnownAgentName(known, "build"), "build");
  });

  it("folds display labels and casing onto the execution id", () => {
    NodeAssert.equal(matchKnownAgentName(known, "Build"), "build");
    NodeAssert.equal(matchKnownAgentName(known, "BUILD"), "build");
    NodeAssert.equal(matchKnownAgentName(known, "Plan"), "plan");
  });

  it("returns undefined for unknown names so callers use the server default", () => {
    NodeAssert.equal(matchKnownAgentName(known, "deploy"), undefined);
    NodeAssert.equal(matchKnownAgentName([], "build"), undefined);
  });
});

describe("buildOpenCodeV2PermissionRules", () => {
  it("uses the v2 shell action instead of bash", () => {
    const rules = buildOpenCodeV2PermissionRules("approval-required");
    const shell = rules.findLast((rule) => rule.action === "shell");
    NodeAssert.equal(shell?.effect, "ask");
    NodeAssert.equal(
      rules.some((rule) => rule.action === "bash"),
      false,
    );
  });

  it("drops actions that are not v2 Core permission actions", () => {
    const rules = buildOpenCodeV2PermissionRules("approval-required");
    for (const action of ["lsp", "doom_loop"]) {
      NodeAssert.equal(
        rules.some((rule) => rule.action === action),
        false,
      );
    }
  });

  it("pre-approves edits only in auto-accept-edits mode", () => {
    const editEffect = (mode: Parameters<typeof buildOpenCodeV2PermissionRules>[0]) =>
      buildOpenCodeV2PermissionRules(mode).findLast((rule) => rule.action === "edit")?.effect;
    NodeAssert.equal(editEffect("auto-accept-edits"), "allow");
    NodeAssert.equal(editEffect("approval-required"), "ask");
    NodeAssert.equal(editEffect("auto"), "ask");
  });

  it("keeps environment-file read approvals and allows everything under full access", () => {
    const rules = buildOpenCodeV2PermissionRules("approval-required");
    NodeAssert.equal(
      rules.findLast((rule) => rule.action === "read" && rule.resource === "*.env")?.effect,
      "ask",
    );
    NodeAssert.deepEqual(buildOpenCodeV2PermissionRules("full-access"), [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ]);
  });
});

describe("loadOpenCodeV2Inventory", () => {
  const fullLists = {
    provider: {
      list: async () => ({
        location: { directory: "/tmp" },
        data: [{ id: "acme", name: "Acme" }],
      }),
    },
    model: {
      list: async () => ({
        location: { directory: "/tmp" },
        data: [
          {
            id: "m1",
            modelID: "m1",
            providerID: "acme",
            name: "Acme One",
            enabled: true,
            variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
          },
          {
            id: "m2",
            modelID: "m2",
            providerID: "acme",
            name: "Acme Two",
            enabled: false,
            variants: [],
          },
          {
            id: "m3",
            modelID: "m3",
            providerID: "other",
            name: "Other Three",
            enabled: true,
            variants: [],
          },
        ],
      }),
    },
    agent: {
      list: async () => ({
        location: { directory: "/tmp" },
        data: [{ name: "build", mode: "primary", hidden: false }],
      }),
    },
    skill: {
      list: async () => ({
        location: { directory: "/tmp" },
        data: [{ id: "s", name: "review", description: "Review", path: "/skills/review.md" }],
      }),
    },
    command: {
      list: async () => ({
        location: { directory: "/tmp" },
        data: [{ name: "init", description: "Setup" }],
      }),
    },
  };

  effectIt.effect("normalizes v2 lists into the shared inventory shape", () =>
    Effect.gen(function* () {
      const inventory = yield* loadOpenCodeV2Inventory(
        fullLists as unknown as OpenCodeV2Client,
        "/tmp",
      );
      // Disabled models are excluded; model-only providers are synthesized.
      NodeAssert.deepEqual(inventory.providerList.connected.sort(), ["acme", "other"]);
      const acme = inventory.providerList.all.find((provider) => provider.id === "acme");
      NodeAssert.deepEqual(Object.keys(acme?.models ?? {}), ["m1"]);
      NodeAssert.deepEqual(Object.keys(acme?.models.m1?.variants ?? {}), ["high"]);
      // Skills map path to location; commands default to empty hints.
      NodeAssert.deepEqual(inventory.skills, [
        { name: "review", description: "Review", location: "/skills/review.md" },
      ]);
      NodeAssert.deepEqual(inventory.commands, [{ name: "init", description: "Setup", hints: [] }]);
      NodeAssert.equal(inventory.agents[0]?.name, "build");
    }),
  );

  effectIt.effect("retries an unsettled (empty) first read", () =>
    Effect.gen(function* () {
      let settled = false;
      const empty = { location: { directory: "/tmp" }, data: [] };
      const flaky = {
        provider: { list: async () => (settled ? fullLists.provider.list() : empty) },
        model: { list: async () => (settled ? fullLists.model.list() : empty) },
        agent: { list: async () => fullLists.agent.list() },
        skill: { list: async () => fullLists.skill.list() },
        command: { list: async () => fullLists.command.list() },
      };
      const fiber = yield* loadOpenCodeV2Inventory(
        flaky as unknown as OpenCodeV2Client,
        "/tmp",
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      settled = true;
      yield* TestClock.adjust("10 seconds");
      const inventory = yield* Fiber.join(fiber);
      NodeAssert.ok(inventory.providerList.connected.length > 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("retries a transient inventory failure once", () =>
    Effect.gen(function* () {
      let calls = 0;
      const flaky = {
        provider: {
          list: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error("cold server");
            }
            return fullLists.provider.list();
          },
        },
        model: { list: async () => fullLists.model.list() },
        agent: { list: async () => fullLists.agent.list() },
        skill: { list: async () => fullLists.skill.list() },
        command: { list: async () => fullLists.command.list() },
      };
      const fiber = yield* loadOpenCodeV2Inventory(
        flaky as unknown as OpenCodeV2Client,
        "/tmp",
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const inventory = yield* Fiber.join(fiber);
      NodeAssert.ok(inventory.providerList.connected.length > 0);
      NodeAssert.ok(calls >= 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
