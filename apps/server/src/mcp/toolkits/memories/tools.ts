import {
  DOER_MEMORY_MAX_CONTENT_CHARS,
  DoerMemory,
  DoerMemoryScope,
} from "@t3tools/shared/doerMemory";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as DoerMemoryStore from "../../../persistence/Services/DoerMemoryStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  DoerMemoryStore.DoerMemoryStore,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export class MemoryNotFoundError extends Schema.TaggedError<MemoryNotFoundError>()(
  "MemoryNotFoundError",
  {
    memoryId: Schema.String,
  },
) {
  override get message(): string {
    return `No saved memory '${this.memoryId}' exists in this Task's scope. Call list_memories to see what this Task can see.`;
  }
}

export class MemorySaveFailedError extends Schema.TaggedError<MemorySaveFailedError>()(
  "MemorySaveFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Saving the memory failed, so nothing was saved. Check the detail and try again.";
  }
}

export class MemoryListFailedError extends Schema.TaggedError<MemoryListFailedError>()(
  "MemoryListFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Listing saved memories failed.";
  }
}

export class MemorySearchFailedError extends Schema.TaggedError<MemorySearchFailedError>()(
  "MemorySearchFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Searching saved memories failed.";
  }
}

export class MemoryUpdateFailedError extends Schema.TaggedError<MemoryUpdateFailedError>()(
  "MemoryUpdateFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Updating the memory failed, so the previous version is unchanged.";
  }
}

export class MemoryForgetFailedError extends Schema.TaggedError<MemoryForgetFailedError>()(
  "MemoryForgetFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Forgetting the memory failed, so it is still saved.";
  }
}

export const MemoryToolError = Schema.Union([
  MemoryNotFoundError,
  MemorySaveFailedError,
  MemoryListFailedError,
  MemorySearchFailedError,
  MemoryUpdateFailedError,
  MemoryForgetFailedError,
]);
export type MemoryToolError = typeof MemoryToolError.Type;

const MemoryContentInput = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(DOER_MEMORY_MAX_CONTENT_CHARS),
).annotate({
  description:
    "One fact in plain words, up to 500 characters. Never passwords, keys, tokens, or sign-in codes.",
});

const RememberMemoryInput = Schema.Struct({
  content: MemoryContentInput,
  scope: Schema.optional(
    DoerMemoryScope.annotate({
      description:
        "Where to save it. 'space' (default) saves to This Space, visible in this Task's Space. 'about-you' saves to About you, visible across Spaces on this computer.",
    }),
  ),
});

const ListMemoriesInput = Schema.Struct({
  scope: Schema.optional(
    DoerMemoryScope.annotate({
      description: "Omit to see everything this Task can see (About you plus This Space).",
    }),
  ),
});

const SearchMemoriesInput = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)).annotate({
    description: "Words to find in saved memories.",
  }),
});

const MemoryRefInput = Schema.Struct({
  memoryId: Schema.String.annotate({
    description: "Memory id from list_memories, search_memories, or remember_memory.",
  }),
});

const UpdateMemoryInput = Schema.Struct({
  memoryId: Schema.String.annotate({
    description: "Memory id from list_memories, search_memories, or remember_memory.",
  }),
  content: MemoryContentInput,
});

const RememberedMemory = Schema.Struct({
  memory: DoerMemory,
  message: Schema.String,
});

const RememberMemoryTool = Tool.make("remember_memory", {
  description:
    "Save something the user explicitly asked Doer to remember, after they said it or confirmed your suggestion. Saves to This Space by default; pass scope 'about-you' only for facts about the person that belong everywhere. Never save guesses, document content, or secrets (passwords, keys, tokens, codes). The result confirms what was actually saved — report that, never invent a save.",
  parameters: RememberMemoryInput,
  success: RememberedMemory,
  failure: MemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Remember")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListMemoriesTool = Tool.make("list_memories", {
  description:
    "List what this Task can see: About you plus This Space. Never another Space's memories. Call it before updating or forgetting, and when the user asks what Doer remembers.",
  parameters: ListMemoriesInput,
  success: Schema.Struct({ memories: Schema.Array(DoerMemory) }),
  failure: MemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "List memories")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchMemoriesTool = Tool.make("search_memories", {
  description:
    "Search what this Task can see (About you plus This Space) for words. Use it to find the right memory before updating or forgetting it.",
  parameters: SearchMemoriesInput,
  success: Schema.Struct({
    query: Schema.String,
    memories: Schema.Array(DoerMemory),
  }),
  failure: MemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search memories")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpdateMemoryTool = Tool.make("update_memory", {
  description:
    "Correct a saved memory by id when the user says it changed or is wrong. Only memories this Task can see (About you plus This Space) can be updated. The result confirms the corrected version — earlier conversation may still contain the old wording.",
  parameters: UpdateMemoryInput,
  success: RememberedMemory,
  failure: MemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Correct memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ForgetMemoryTool = Tool.make("forget_memory", {
  description:
    "Forget a saved memory by id when the user asks to forget it. Only memories this Task can see (About you plus This Space) can be forgotten. It stops future recall; earlier conversation with a provider may still contain it, so do not promise full erasure.",
  parameters: MemoryRefInput,
  success: Schema.Struct({
    memoryId: Schema.String,
    scope: DoerMemoryScope,
    message: Schema.String,
  }),
  failure: MemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Forget memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MemoriesToolkit = Toolkit.make(
  RememberMemoryTool,
  ListMemoriesTool,
  SearchMemoriesTool,
  UpdateMemoryTool,
  ForgetMemoryTool,
);
