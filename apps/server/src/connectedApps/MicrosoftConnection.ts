// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { MicrosoftAccount } from "./MicrosoftAccount.ts";
export class MicrosoftConnection extends Context.Service<MicrosoftConnection, MicrosoftAccount>()(
  "@lag4/doer-cli/connectedApps/MicrosoftConnection",
) {}
export const layer = Layer.effect(
  MicrosoftConnection,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    return new MicrosoftAccount({
      clientId: process.env.DOER_MICROSOFT_CLIENT_ID?.trim() ?? "",
      fetch: globalThis.fetch,
      storage: {
        get: (name) => Effect.runPromise(secrets.get(name)).then(Option.getOrNull),
        set: (name, value) => Effect.runPromise(secrets.set(name, value)),
        remove: (name) => Effect.runPromise(secrets.remove(name)),
      },
    });
  }),
);
