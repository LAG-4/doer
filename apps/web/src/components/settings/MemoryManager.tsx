import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ThreadId as ThreadIdBrand } from "@t3tools/contracts";
import {
  createDoerMemory,
  DoerMemoryRequestError,
  forgetDoerMemory,
  listDoerMemories,
  updateDoerMemory,
  type DoerMemoryTransport,
} from "@t3tools/client-runtime/doer-memory";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DOER_MEMORY_COPY,
  DOER_MEMORY_MAX_CONTENT_CHARS,
  type DoerMemory,
  type DoerMemoryScope,
} from "@t3tools/shared/doerMemory";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePreparedConnection } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

const MAX_ADD_CHARS = DOER_MEMORY_MAX_CONTENT_CHARS;

function describeSourceSpark(sourceThreadId: string): string {
  return sourceThreadId === "settings" ? "Added in Settings" : "Saved in a task";
}

function MemoryRow(props: {
  entry: DoerMemory;
  environmentId: EnvironmentId;
  busy: boolean;
  editing: boolean;
  editDraft: string;
  confirming: boolean;
  onStartEdit: () => void;
  onEditChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onAskForget: () => void;
  onCancelForget: () => void;
  onConfirmForget: () => void;
}) {
  const router = useRouter();
  const { entry } = props;
  const openSourceTask = useCallback(() => {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(props.environmentId, ThreadIdBrand.make(entry.sourceThreadId) as ThreadId),
      ),
    });
  }, [router, props.environmentId, entry.sourceThreadId]);
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2">
      {props.editing ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`memory-edit-${entry.id}`}>Correct this memory</Label>
          <Textarea
            id={`memory-edit-${entry.id}`}
            value={props.editDraft}
            rows={2}
            maxLength={MAX_ADD_CHARS}
            disabled={props.busy}
            onChange={(event) => props.onEditChange(event.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={props.busy} onClick={props.onSaveEdit}>
              {props.busy ? "Saving…" : "Save correction"}
            </Button>
            <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancelEdit}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm">{entry.content}</p>
            <p className="text-xs text-muted-foreground">
              {entry.sourceThreadId === "settings" ? (
                describeSourceSpark(entry.sourceThreadId)
              ) : (
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2"
                  onClick={openSourceTask}
                >
                  {describeSourceSpark(entry.sourceThreadId)}
                </button>
              )}{" "}
              · Updated {new Date(entry.updatedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Correct ${entry.content.slice(0, 40)}`}
              disabled={props.busy}
              onClick={props.onStartEdit}
            >
              <PencilIcon />
            </Button>
            {props.confirming ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={props.busy}
                onClick={props.onConfirmForget}
              >
                {props.busy ? "Forgetting…" : "Confirm forget"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Forget ${entry.content.slice(0, 40)}`}
                disabled={props.busy}
                onClick={props.onAskForget}
              >
                <Trash2Icon />
              </Button>
            )}
            {props.confirming ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy}
                onClick={props.onCancelForget}
              >
                Keep
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

const MemoMemoryRow = memo(MemoryRow);

export function MemoryManager(props: {
  environmentId: EnvironmentId;
  scope: DoerMemoryScope;
  /** All project ids behind this Space group; writes go to the first. Null for About you. */
  projectId?: string | undefined;
  sectionId: string;
  title: string;
  description: string;
}) {
  const prepared = usePreparedConnection(props.environmentId);
  const connection = useMemo(() => {
    if (Option.isNone(prepared)) return null;
    const authorization = prepared.value.httpAuthorization;
    if (authorization !== null && authorization._tag !== "Bearer") return { relay: true as const };
    return {
      transport: {
        baseUrl: prepared.value.httpBaseUrl,
        fetchFn: fetch,
        ...(authorization !== null ? { authHeader: `Bearer ${authorization.token}` } : {}),
      } satisfies DoerMemoryTransport,
    };
  }, [prepared]);
  if (connection === null) {
    return (
      <SettingsSection id={props.sectionId} title={props.title}>
        <p role="status" className="text-sm text-muted-foreground">
          Connecting…
        </p>
      </SettingsSection>
    );
  }
  if ("relay" in connection) {
    return (
      <SettingsSection id={props.sectionId} title={props.title}>
        <p className="text-sm text-muted-foreground">
          Memory settings are not available over this relay connection yet. Ask Doer in chat to
          remember, change, or forget things instead.
        </p>
      </SettingsSection>
    );
  }
  return (
    <MemoryManagerLoaded
      key={`${props.environmentId}:${props.scope}:${props.projectId ?? "about-you"}`}
      environmentId={props.environmentId}
      transport={connection.transport}
      scope={props.scope}
      projectId={props.projectId}
      sectionId={props.sectionId}
      title={props.title}
      description={props.description}
    />
  );
}

function MemoryManagerLoaded(props: {
  environmentId: EnvironmentId;
  transport: DoerMemoryTransport;
  scope: DoerMemoryScope;
  projectId?: string | undefined;
  sectionId: string;
  title: string;
  description: string;
}) {
  const transport = props.transport;
  const writeProjectId = props.scope === "about-you" ? undefined : props.projectId;
  const query: { scope: DoerMemoryScope } | { scope: "space"; projectId: string | undefined } =
    useMemo(
      () =>
        props.scope === "about-you"
          ? { scope: props.scope }
          : { scope: "space" as const, projectId: props.projectId },
      [props.scope, props.projectId],
    );
  const [entries, setEntries] = useState<ReadonlyArray<DoerMemory> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Guards slow responses: only the latest load may populate the list.
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if ("projectId" in query) {
      if (query.projectId === undefined) return [];
      // Always request scope=space so About-you entries never mix into This Space.
      return listDoerMemories(transport, { scope: "space", projectId: query.projectId });
    }
    return listDoerMemories(transport, { scope: query.scope });
  }, [transport, query]);

  const refresh = useCallback(async () => {
    const generation = (loadGeneration.current += 1);
    setError(null);
    try {
      const loaded = await load();
      if (loadGeneration.current !== generation) return;
      setEntries(loaded);
    } catch (cause) {
      if (loadGeneration.current !== generation) return;
      // Keep previously loaded entries: a failed refresh is not an empty list.
      setEntries((previous) => previous);
      setError(
        cause instanceof DoerMemoryRequestError
          ? cause.message
          : "Could not load memories. Check the connection and try again.",
      );
    }
  }, [load]);

  useEffect(() => {
    setEntries(null);
    void refresh();
  }, [refresh]);

  const mutate = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await work();
      } catch (cause) {
        setError(
          cause instanceof DoerMemoryRequestError
            ? cause.message
            : "Could not confirm the change. Refresh the list before trying again.",
        );
        setBusy(false);
        return;
      }
      setNotice(done);
      try {
        const generation = (loadGeneration.current += 1);
        const loaded = await load();
        if (loadGeneration.current === generation) setEntries(loaded);
      } catch {
        // The save succeeded; only the refresh failed.
        setError("Saved, but the list could not be refreshed. Reopen Settings to see it.");
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  const add = useCallback(() => {
    const content = draft.trim();
    if (content === "") {
      setError("Write the memory first.");
      return;
    }
    if (props.scope !== "about-you" && writeProjectId === undefined) {
      setError("This Space is not available right now. Reconnect and try again.");
      return;
    }
    void mutate(
      () =>
        createDoerMemory(transport, {
          content,
          scope: props.scope,
          ...(writeProjectId ? { projectId: writeProjectId } : {}),
        }).then(() => setDraft("")),
      props.scope === "about-you"
        ? "Saved to About you. Available starting next message."
        : "Saved to This Space. Available starting next message.",
    );
  }, [draft, mutate, transport, props.scope, writeProjectId]);

  const saveEdit = useCallback(
    (entry: DoerMemory) =>
      void mutate(
        () =>
          updateDoerMemory(transport, entry.id, {
            content: editDraft,
            ...(entry.projectId ? { projectId: entry.projectId } : {}),
          }).then(() => {
            setEditingId(null);
          }),
        "Updated. Available starting next message.",
      ),
    [editDraft, mutate, transport],
  );

  const confirmForget = useCallback(
    (entry: DoerMemory) =>
      void mutate(
        () =>
          forgetDoerMemory(transport, entry.id, {
            ...(entry.projectId ? { projectId: entry.projectId } : {}),
          }).then(() => {
            setConfirmingId(null);
          }),
        "Forgotten. It will not appear in future messages.",
      ),
    [mutate, transport],
  );

  return (
    <SettingsSection id={props.sectionId} title={props.title}>
      <p className="text-sm text-muted-foreground">{props.description}</p>
      {entries === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading saved memories…
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing saved here yet. Ask Doer to remember something in chat, or add one below.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <MemoMemoryRow
              key={entry.id}
              entry={entry}
              environmentId={props.environmentId}
              busy={busy}
              editing={editingId === entry.id}
              editDraft={editingId === entry.id ? editDraft : ""}
              confirming={confirmingId === entry.id}
              onStartEdit={() => {
                setEditingId(entry.id);
                setEditDraft(entry.content);
                setConfirmingId(null);
              }}
              onEditChange={setEditDraft}
              onSaveEdit={() => saveEdit(entry)}
              onCancelEdit={() => setEditingId(null)}
              onAskForget={() => {
                setConfirmingId(entry.id);
                setEditingId(null);
              }}
              onCancelForget={() => setConfirmingId(null)}
              onConfirmForget={() => confirmForget(entry)}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${props.sectionId}-add`}>
          {props.scope === "about-you"
            ? "Remember something about you"
            : "Remember something for this Space"}
        </Label>
        <Textarea
          id={`${props.sectionId}-add`}
          value={draft}
          rows={2}
          maxLength={MAX_ADD_CHARS}
          disabled={busy}
          placeholder={
            props.scope === "about-you"
              ? "Goes by Sam, prefers concise summaries…"
              : "Garden renovation budget is 4000…"
          }
          onChange={(event) => setDraft(event.target.value)}
        />
        <div>
          <Button size="sm" disabled={busy || draft.trim() === ""} onClick={add}>
            <PlusIcon />
            {busy ? "Saving…" : "Remember this"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Memories cannot keep secrets safe — never store passwords, keys, or sign-in codes.{" "}
        {DOER_MEMORY_COPY.localDisclosure}
      </p>
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}
