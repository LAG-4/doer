import {
  createDoerMemory,
  DoerMemoryRequestError,
  forgetDoerMemory,
  listDoerMemories,
  updateDoerMemory,
  type DoerMemoryTransport,
} from "@t3tools/client-runtime/doer-memory";
import {
  DOER_MEMORY_COPY,
  DOER_MEMORY_MAX_CONTENT_CHARS,
  type DoerMemory,
  type DoerMemoryScope,
} from "@t3tools/shared/doerMemory";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import type { SavedRemoteConnection } from "../../lib/connection";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

function transportFor(
  connection: SavedRemoteConnection,
): DoerMemoryTransport | { readonly relay: true } {
  if (
    connection.authenticationMethod === "dpop" ||
    (connection.bearerToken === null && connection.authenticationMethod !== undefined)
  ) {
    return { relay: true };
  }
  return {
    baseUrl: connection.httpBaseUrl,
    fetchFn: fetch,
    ...(connection.bearerToken ? { authHeader: `Bearer ${connection.bearerToken}` } : {}),
  };
}

function MemorySettingsSection(props: {
  readonly connection: SavedRemoteConnection;
  readonly title: string;
  readonly description: string;
  readonly scope: DoerMemoryScope;
  readonly projectIds?: ReadonlyArray<string>;
}) {
  const resolved = useMemo(() => transportFor(props.connection), [props.connection]);
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
    if ("relay" in resolved) return [];
    if (props.scope === "about-you") {
      return listDoerMemories(resolved, { scope: "about-you" });
    }
    // Always request scope=space so About-you entries never mix into This Space.
    const lists = await Promise.all(
      (props.projectIds ?? []).map((projectId) =>
        listDoerMemories(resolved, { scope: "space", projectId }),
      ),
    );
    const merged = new Map<string, DoerMemory>();
    for (const list of lists) for (const entry of list) merged.set(entry.id, entry);
    return [...merged.values()];
  }, [resolved, props.scope, props.projectIds]);

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
    async (work: (transport: DoerMemoryTransport) => Promise<unknown>, done: string) => {
      if ("relay" in resolved || busy) return;
      const transport = resolved;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await work(transport);
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
        setError("Saved, but the list could not be refreshed. Reopen this screen to see it.");
      } finally {
        setBusy(false);
      }
    },
    [busy, load, resolved],
  );

  const writeProjectId =
    props.scope === "about-you" ? undefined : (props.projectIds?.[0] ?? undefined);

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
    const scope = props.scope;
    void mutate(
      (transport) =>
        createDoerMemory(transport, {
          content,
          scope,
          ...(writeProjectId ? { projectId: writeProjectId } : {}),
        }).then(() => setDraft("")),
      scope === "about-you"
        ? "Saved to About you. Available starting next message."
        : "Saved to This Space. Available starting next message.",
    );
  }, [draft, mutate, props.scope, writeProjectId]);

  if ("relay" in resolved) {
    return (
      <SettingsSection title={props.title}>
        <Text className="text-base text-foreground-muted">
          Memory settings are not available over this relay connection yet. Ask Doer in chat to
          remember, change, or forget things instead.
        </Text>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={props.title}>
      <Text className="text-base text-foreground-muted">{props.description}</Text>
      {entries === null ? (
        <Text className="text-base text-foreground-muted">Loading saved memories…</Text>
      ) : entries.length === 0 ? (
        <Text className="text-base text-foreground-muted">
          Nothing saved here yet. Ask Doer to remember something in chat, or add one below.
        </Text>
      ) : (
        <View className="gap-2">
          {entries.map((entry) => (
            <View key={entry.id} className="gap-1 rounded-lg border border-border p-3">
              {editingId === entry.id ? (
                <View className="gap-2">
                  <AppTextInput
                    value={editDraft}
                    onChangeText={setEditDraft}
                    multiline
                    maxLength={DOER_MEMORY_MAX_CONTENT_CHARS}
                    editable={!busy}
                    accessibilityLabel="Correct this memory"
                  />
                  <View className="flex-row gap-2">
                    <MemoryButton
                      label={busy ? "Saving…" : "Save correction"}
                      disabled={busy}
                      onPress={() =>
                        void mutate(
                          () =>
                            updateDoerMemory(resolved, entry.id, {
                              content: editDraft,
                              ...(entry.projectId ? { projectId: entry.projectId } : {}),
                            }).then(() => setEditingId(null)),
                          "Updated. Available starting next message.",
                        )
                      }
                    />
                    <MemoryButton
                      label="Discard"
                      disabled={busy}
                      onPress={() => setEditingId(null)}
                    />
                  </View>
                </View>
              ) : (
                <View className="gap-1">
                  <Text className="text-base">{entry.content}</Text>
                  <Text className="text-sm text-foreground-muted">
                    {entry.sourceThreadId === "settings" ? "Added in Settings" : "Saved in a task"}{" "}
                    · Updated {new Date(entry.updatedAt).toLocaleDateString()}
                  </Text>
                  <View className="flex-row gap-2">
                    <MemoryButton
                      label="Correct"
                      disabled={busy}
                      onPress={() => {
                        setEditingId(entry.id);
                        setEditDraft(entry.content);
                        setConfirmingId(null);
                      }}
                    />
                    {confirmingId === entry.id ? (
                      <MemoryButton
                        label={busy ? "Forgetting…" : "Confirm forget"}
                        disabled={busy}
                        onPress={() =>
                          void mutate(
                            () =>
                              forgetDoerMemory(resolved, entry.id, {
                                ...(entry.projectId ? { projectId: entry.projectId } : {}),
                              }).then(() => setConfirmingId(null)),
                            "Forgotten. It will not appear in future messages.",
                          )
                        }
                      />
                    ) : (
                      <MemoryButton
                        label="Forget"
                        disabled={busy}
                        onPress={() => {
                          setConfirmingId(entry.id);
                          setEditingId(null);
                        }}
                      />
                    )}
                    {confirmingId === entry.id ? (
                      <MemoryButton
                        label="Keep"
                        disabled={busy}
                        onPress={() => setConfirmingId(null)}
                      />
                    ) : null}
                  </View>
                </View>
              )}
            </View>
          ))}
        </View>
      )}
      <View className="gap-2">
        <AppTextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={DOER_MEMORY_MAX_CONTENT_CHARS}
          editable={!busy}
          placeholder={
            props.scope === "about-you"
              ? "Goes by Sam, prefers concise summaries…"
              : "Garden renovation budget is 4000…"
          }
          accessibilityLabel={
            props.scope === "about-you"
              ? "Remember something about you"
              : "Remember something for this Space"
          }
        />
        <MemoryButton
          label={busy ? "Saving…" : "Remember this"}
          disabled={busy || draft.trim() === ""}
          onPress={add}
        />
      </View>
      <Text className="text-sm text-foreground-muted">
        Memories cannot keep secrets safe — never store passwords, keys, or sign-in codes.{" "}
        {DOER_MEMORY_COPY.localDisclosure}
      </Text>
      {notice !== null ? <Text className="text-base text-foreground-muted">{notice}</Text> : null}
      {error !== null ? (
        <View className="flex-row items-center gap-2">
          <Text className="text-base text-danger-foreground">{error}</Text>
          <MemoryButton label="Retry" disabled={busy} onPress={() => void refresh()} />
        </View>
      ) : null}
    </SettingsSection>
  );
}

function MemoryButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-lg border border-border px-3 py-2"
    >
      <Text className="text-base">{props.label}</Text>
    </Pressable>
  );
}

export function SettingsMemoriesRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const connections = useMemo(
    () =>
      selectedTargets
        .map((target) => savedConnectionsById[target.environmentId])
        .filter((connection): connection is SavedRemoteConnection => connection !== undefined),
    [selectedTargets, savedConnectionsById],
  );
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const selectedEnvironmentIds = new Set(selectedTargets.map((entry) => entry.environmentId));

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Memories" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {connections.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Connect an environment to see what Doer remembers.
            </Text>
          ) : (
            connections.map((connection) => {
              const members =
                group?.members
                  .map((member) => member.project)
                  .filter(
                    (project) =>
                      project.environmentId === connection.environmentId &&
                      selectedEnvironmentIds.has(project.environmentId),
                  ) ?? [];
              return (
                <View key={connection.environmentId} className="gap-6">
                  <MemorySettingsSection
                    key={`${connection.environmentId}:about-you`}
                    connection={connection}
                    title={`About you · ${connection.environmentLabel}`}
                    description="Used across your Spaces on this computer. You choose what Doer remembers — ask in chat or add it here."
                    scope="about-you"
                  />
                  {members.map((member) => (
                    <MemorySettingsSection
                      key={`${connection.environmentId}:${member.id}`}
                      connection={connection}
                      title={`This Space · ${member.title}`}
                      description="Used for Tasks in this Space on this computer. Review, correct, or forget it any time."
                      scope="space"
                      projectIds={[String(member.id)]}
                    />
                  ))}
                </View>
              );
            })
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}
