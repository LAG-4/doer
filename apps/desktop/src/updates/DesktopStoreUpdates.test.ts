import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

/** The installed Microsoft Store package must never self-update:
    the Store owns updates and electron-updater cannot run there. */
describe("DesktopUpdates Microsoft Store gate", () => {
  it.effect("disables self-update and never touches electron-updater", () => {
    const harness = makeHarness({ platform: "win32", isWindowsStore: true });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.equal(state.enabled, false);
        assert.equal(state.status, "disabled");

        const reason = yield* updates.disabledReason;
        assert.deepStrictEqual(
          reason,
          Option.some(
            "Automatic updates are managed by the Microsoft Store for the Store package.",
          ),
        );

        // No listeners means no checks, downloads, installs, or pollers can
        // ever reach electron-updater from this build — including the mock
        // feed the harness enables by default.
        assert.equal(harness.listenerCount(), 0);
        assert.deepStrictEqual(harness.setterCounts(), {
          setFeedURL: 0,
          setAutoDownload: 0,
          setAutoInstallOnAppQuit: 0,
          setChannel: 0,
          setAllowPrerelease: 0,
          setAllowDowngrade: 0,
          setFullChangelog: 0,
          setDisableDifferentialDownload: 0,
        });
        assert.equal(harness.feedUrls().length, 0);

        const check = yield* updates.check("manual");
        assert.equal(check.checked, false);
        assert.equal(harness.checkCount(), 0);

        const download = yield* updates.download;
        assert.equal(download.accepted, false);
        assert.equal(harness.downloadCount(), 0);

        const install = yield* updates.install;
        assert.equal(install.accepted, false);
        assert.equal(harness.quitAndInstalls(), 0);

        // A channel change on the Store build only rewrites local state;
        // it must not configure the updater either.
        const afterChannel = yield* updates.setChannel("nightly");
        assert.equal(afterChannel.channel, "nightly");
        assert.equal(afterChannel.enabled, false);
        assert.equal(harness.listenerCount(), 0);
        assert.equal(harness.feedUrls().length, 0);
        assert.equal(harness.setterCounts().setChannel, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("leaves direct-download Windows installs on self-update", () => {
    const harness = makeHarness({ platform: "win32" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.equal(state.enabled, true);
        assert.equal(state.status, "idle");

        const reason = yield* updates.disabledReason;
        assert.deepStrictEqual(reason, Option.none());

        // The mock feed is configured for enabled builds.
        assert.equal(harness.feedUrls().length, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
