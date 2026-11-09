import type { EnvironmentId } from "@t3tools/contracts";
import type { ExperimentalConnectionsTransport } from "@t3tools/client-runtime/experimental-connections";
import * as Option from "effect/Option";
import { useEffect, useState, useSyncExternalStore } from "react";

import { usePreparedConnection } from "../../state/session";
import {
  readExperimentalConnectionsSnapshot,
  refreshExperimentalConnections,
  saveExperimentalConnections,
  subscribeExperimentalConnections,
} from "./experimentalConnectionsStore";

/** Host-scoped experimental-connections flag. Unknown (null) until first load resolves. */
export function useExperimentalConnections(environmentId: EnvironmentId | null): {
  readonly enabled: boolean | null;
  readonly error: string | null;
  readonly errorKind: "load" | "save" | null;
  readonly saving: boolean;
  readonly setEnabled: (enabled: boolean) => Promise<boolean>;
  readonly refresh: () => void;
} {
  const prepared = usePreparedConnection(environmentId);
  const authorization = Option.isNone(prepared) ? null : prepared.value.httpAuthorization;
  const transport =
    environmentId === null ||
    Option.isNone(prepared) ||
    (authorization !== null && authorization._tag !== "Bearer")
      ? null
      : {
          key: environmentId,
          transport: {
            baseUrl: prepared.value.httpBaseUrl,
            // Arrow wrapper keeps native fetch's receiver: passing bare `fetch`
            // and invoking it as `transport.fetchFn(...)` throws "Illegal
            // invocation" in browsers and no request is sent.
            fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
            ...(authorization !== null ? { authHeader: `Bearer ${authorization.token}` } : {}),
          } satisfies ExperimentalConnectionsTransport,
        };
  const key = transport?.key ?? "";
  const snapshot = useSyncExternalStore(
    (notify: () => void) => subscribeExperimentalConnections(key, notify),
    () => readExperimentalConnectionsSnapshot(key),
  );
  const [saving, setSaving] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads server state into the shared module cache when transport changes
  useEffect(() => {
    if (transport === null) return;
    void refreshExperimentalConnections(transport.key, transport.transport);
  }, [transport]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidates the module cache on window focus via an outside-React listener
  useEffect(() => {
    if (transport === null || typeof window === "undefined") return;
    const onFocus = () => {
      void refreshExperimentalConnections(transport.key, transport.transport);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [transport]);

  const setEnabled = async (enabled: boolean) => {
    if (transport === null || saving) return false;
    setSaving(true);
    try {
      return await saveExperimentalConnections(transport.key, transport.transport, enabled);
    } finally {
      setSaving(false);
    }
  };

  const refresh = () => {
    if (transport !== null) void refreshExperimentalConnections(transport.key, transport.transport);
  };

  return {
    enabled: transport === null ? null : snapshot.enabled,
    error: snapshot.error,
    errorKind: snapshot.errorKind,
    saving,
    setEnabled,
    refresh,
  };
}
