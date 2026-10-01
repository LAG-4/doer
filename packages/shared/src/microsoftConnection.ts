import * as Schema from "effect/Schema";
export const MicrosoftStatus = Schema.Struct({
  configured: Schema.Boolean,
  connected: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
  sharePoint: Schema.Boolean,
});
export type MicrosoftStatus = typeof MicrosoftStatus.Type;
export const MicrosoftSignIn = Schema.Struct({
  userCode: Schema.String,
  verificationUrl: Schema.String,
  expiresAt: Schema.Number,
  intervalSeconds: Schema.Number,
});
export type MicrosoftSignIn = typeof MicrosoftSignIn.Type;
export const MicrosoftResponse = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status"), status: MicrosoftStatus }),
  Schema.Struct({ kind: Schema.Literal("sign-in"), signIn: MicrosoftSignIn }),
  Schema.Struct({ kind: Schema.Literal("waiting"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("error"), message: Schema.String }),
]);
export type MicrosoftResponse = typeof MicrosoftResponse.Type;
export const MicrosoftAction = Schema.Struct({
  action: Schema.Literals(["status", "start", "finish", "disconnect"]),
  sharePoint: Schema.optional(Schema.Boolean),
});
