import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type Project } from "@t3tools/contracts";
import { HostProcessHomeDirectory } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProjectService from "../project/ProjectService.ts";
import { resolveInboxWelcomeTargets } from "./InboxProvisioning.ts";

it.effect.each([true, false])("provisions the inbox, existing=%s", (exists) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "doer-inbox-test-" });
    const root = path.join(home, "Documents", "Doer");
    const project: Project = {
      id: ProjectId.make("inbox"),
      title: "My Stuff",
      workspaceRoot: root,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
      deletedAt: null,
    };
    let created = false;
    const result = yield* resolveInboxWelcomeTargets.pipe(
      Effect.provide(
        Layer.mock(ProjectService.ProjectService)({
          getByWorkspaceRoot: () => Effect.succeed(exists ? Option.some(project) : Option.none()),
          bootstrap: (input) =>
            Effect.sync(() => {
              expect(input.workspaceRoot).toBe(root);
              expect(input.createWorkspaceRootIfMissing).toBe(true);
              created = true;
              return { project, created: true };
            }),
        }),
      ),
      Effect.provideService(HostProcessHomeDirectory, home),
    );
    expect(result).toEqual({
      inboxProjectId: project.id,
      inboxProjectCreated: !exists,
      inboxWorkspaceRoot: root,
    });
    expect(created).toBe(!exists);
    expect((yield* fs.stat(root)).type).toBe("Directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);
