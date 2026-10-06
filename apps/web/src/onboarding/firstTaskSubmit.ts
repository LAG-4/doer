import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { sendQueuedMessage } from "../components/chat/sendQueuedMessage";
import { newThreadId, randomUUID } from "../lib/utils";
import { useQueuedMessageStore } from "../queuedMessageStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadEnvironment } from "../state/threads";

export interface FirstTaskSubmitInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly file: File;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Starts the onboarding first task on a brand-new server thread in the
 * given project, reusing the existing queued-send path (attachment upload,
 * turn start, failure holding) so the task behaves exactly like a message
 * sent from the composer.
 *
 * Thread creation failures throw, so the wizard can stay open with its
 * inputs preserved. Send failures never throw: like a composer send, the
 * message stays queued for retry and the caller still gets the thread to
 * navigate to.
 */
export async function submitFirstTask(input: FirstTaskSubmitInput): Promise<ScopedThreadRef> {
  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  const createResult = await runAtomCommand(appAtomRegistry, threadEnvironment.create, {
    environmentId: input.environmentId,
    input: {
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: null,
    },
  });
  if (createResult._tag === "Failure") {
    throw squashAtomCommandFailure(createResult);
  }

  const threadRef = scopeThreadRef(input.environmentId, threadId);
  const queued = useQueuedMessageStore.getState().enqueue(scopedThreadKey(threadRef), {
    prompt: input.prompt,
    images: [],
    files: [
      {
        type: "file",
        id: randomUUID(),
        name: input.file.name || "file",
        mimeType: input.file.type || "application/octet-stream",
        sizeBytes: input.file.size,
        file: input.file,
      },
    ],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    sendSettings: {
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt,
  });
  await sendQueuedMessage(threadRef, queued.id);
  return threadRef;
}
