import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ExperimentalConnectionsStatus } from "@t3tools/shared/experimentalConnections";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ExperimentalConnections from "./ExperimentalConnections.ts";

const StatusJson = Schema.fromJsonString(ExperimentalConnectionsStatus);
const decodeStatus = Schema.decodeEffect(StatusJson);

const testEnv = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-experimental-connections-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const withFreshService = <A, E, R>(
  effect: Effect.Effect<A, E, R | ExperimentalConnections.ExperimentalConnections>,
) =>
  effect.pipe(
    // One combined provide: the service layer takes its filesystem
    // dependencies from the test environment up front.
    Effect.provide(
      Layer.mergeAll(ExperimentalConnections.layer.pipe(Layer.provide(testEnv)), testEnv),
    ),
  );

it.effect("defaults off for new installations", () =>
  Effect.gen(function* () {
    const service = yield* ExperimentalConnections.ExperimentalConnections;
    expect(yield* service.get).toBe(false);
  }).pipe(withFreshService),
);

it.effect("persists across restart via the host settings file", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(path.dirname(config.settingsPath), "experimental-connections.json");

    const first = yield* ExperimentalConnections.ExperimentalConnections;
    expect(yield* first.get).toBe(false);
    yield* first.setEnabled(true);
    expect(yield* first.get).toBe(true);
    // The file a fresh process would read carries the opt-in.
    const stored = yield* decodeStatus(yield* fs.readFileString(filePath));
    expect(stored).toEqual({ enabled: true });

    // A rebuilt service (server restart) sees the persisted opt-in.
    const second = yield* ExperimentalConnections.ExperimentalConnections.pipe(
      Effect.provide(ExperimentalConnections.layer),
    );
    expect(yield* second.get).toBe(true);
    yield* second.setEnabled(false);
    expect(yield* second.get).toBe(false);
  }).pipe(withFreshService),
);

it.effect("fails the toggle and stays off when the setting cannot be saved", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.dirname(config.settingsPath);
    const service = yield* ExperimentalConnections.ExperimentalConnections.pipe(
      Effect.provide(ExperimentalConnections.layer),
    );
    expect(yield* service.get).toBe(false);
    // Read-only host settings directory: persistence must fail loudly and
    // the switch must fail closed instead of claiming durable success.
    yield* fs.chmod(dir, 0o555);
    try {
      const enableResult = yield* Effect.result(service.setEnabled(true));
      expect(enableResult._tag).toBe("Failure");
      expect(yield* service.get).toBe(false);
      const disableResult = yield* Effect.result(service.setEnabled(false));
      expect(disableResult._tag).toBe("Failure");
      expect(yield* service.get).toBe(false);
    } finally {
      yield* fs.chmod(dir, 0o755).pipe(Effect.ignore);
    }
  }).pipe(Effect.provide(testEnv)),
);

it.effect("keeps the file and memory in agreement under concurrent toggles", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(path.dirname(config.settingsPath), "experimental-connections.json");
    const service = yield* ExperimentalConnections.ExperimentalConnections.pipe(
      Effect.provide(ExperimentalConnections.layer),
    );
    yield* Effect.all(
      Array.from({ length: 12 }, (_, index) => service.setEnabled(index % 2 === 0)),
      { concurrency: "unbounded" },
    );
    const raw = yield* fs.readFileString(filePath);
    const reconciled = yield* decodeStatus(raw);
    expect(reconciled.enabled).toBe(yield* service.get);
  }).pipe(Effect.provide(testEnv)),
);

it.effect("treats a corrupt file as off without throwing", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(path.dirname(config.settingsPath), "experimental-connections.json");
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, "not json{{{");

    const service = yield* ExperimentalConnections.ExperimentalConnections.pipe(
      Effect.provide(ExperimentalConnections.layer),
    );
    expect(yield* service.get).toBe(false);
  }).pipe(Effect.provide(testEnv)),
);

it.effect("reads absent service as off and test layer as explicit", () =>
  Effect.gen(function* () {
    expect(yield* ExperimentalConnections.isEnabled).toBe(false);
    const enabled = yield* ExperimentalConnections.isEnabled.pipe(
      Effect.provide(ExperimentalConnections.layerTest(true)),
    );
    expect(enabled).toBe(true);
    const disabled = yield* ExperimentalConnections.isEnabled.pipe(
      Effect.provide(ExperimentalConnections.layerTest(false)),
    );
    expect(disabled).toBe(false);
  }),
);
