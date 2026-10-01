import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { MicrosoftAction } from "@t3tools/shared/microsoftConnection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { MicrosoftConnection } from "./MicrosoftConnection.ts";
import { MicrosoftAccountError } from "./MicrosoftAccount.ts";

export const routeLayer = HttpRouter.add(
  "POST",
  "/api/doer/microsoft",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const connection = yield* MicrosoftConnection;
    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MicrosoftAction)),
    );
    const result = yield* Effect.tryPromise({
      try: async () => {
        if (input.action === "start")
          return { kind: "sign-in", signIn: await connection.start(input.sharePoint ?? false) };
        if (input.action === "finish") {
          const result = await connection.finish();
          return "waiting" in result
            ? { kind: "waiting", message: result.waiting }
            : { kind: "status", status: result.status };
        }
        return {
          kind: "status",
          status: await (input.action === "disconnect"
            ? connection.disconnect()
            : connection.status()),
        };
      },
      catch: (error) =>
        new MicrosoftAccountError(
          error instanceof MicrosoftAccountError
            ? error.message
            : "The Microsoft connection could not be updated. Check the connection and try again.",
        ),
    }).pipe(Effect.catch((error) => Effect.succeed({ kind: "error", message: error.message })));
    return HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } });
  }),
);
