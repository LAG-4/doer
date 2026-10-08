import type { EnvironmentId } from "@t3tools/contracts";
import type { ExperimentalConnectionsTransport } from "@t3tools/client-runtime/experimental-connections";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { usePreparedConnection } from "../../state/session";
import {
  readExperimentalConnectionsSnapshot,
  refreshExperimentalConnections,
  saveExperimentalConnections,
  subscribeExperimentalConnections,
} from "./experimentalConnectionsStore";

/**
 * Host-scoped experimental-connections flag for one computer.
 *
 * Shares the module cache across every mounted consumer, so the Settings
 * toggle, composer menus, and search availability always agree on one
 * client. Unknown (`null`) until the first load resolves; callers hide
 * gated surfaces until the server answers on — explicit enable only.
 */
export function useExperimentalConnections(environmentId: EnvironmentId | null): {
  readonly enabled: boolean | null;
  readonly error: string | null;
  readonly errorKind: "load" | "save" | null;
  readonly saving: boolean;
  readonly setEnabled: (enabled: boolean) => Promise<boolean>;
  readonly refresh: () => void;
} {
  const prepared = usePreparedConnection(environmentId);
  const transport = useMemo(() => {
    if (environmentId === null || Option.isNone(prepared)) return null;
    const authorization = prepared.value.httpAuthorization;
    if (authorization !== null && authorization._tag !== "Bearer") return null;
    return {
      key: environmentId,
      transport: {
        baseUrl: prepared.value.httpBaseUrl,
        // Arrow wrapper keeps native fetch's receiver: passing bare `fetch`
        // and invoking it as `transport.fetchFn(...)` throws "Illegal
        // invocation" in browsers and no request is sent.
        fetchFn: (...args) => fetch(...args),
        ...(authorization !== null ? { authHeader: `Bearer ${authorization.token}` } : {}),
      } satisfies ExperimentalConnectionsTransport,
    };
  }, [environmentId, prepared]);
  const key = transport?.key ?? "";
  const snapshot = useSyncExternalStore(
    useCallback((notify: () => void) => subscribeExperimentalConnections(key, notify), [key]),
    () => readExperimentalConnectionsSnapshot(key),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (transport === null) return;
    void refreshExperimentalConnections(transport.key, transport.transport);
  }, [transport]);

  useEffect(() => {
    if (transport === null || typeof window === "undefined") return;
    const onFocus = () => {
      void refreshExperimentalConnections(transport.key, transport.transport);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [transport]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (transport === null || saving) return false;
      setSaving(true);
      try {
        return await saveExperimentalConnections(transport.key, transport.transport, enabled);
      } finally {
        setSaving(false);
      }
    },
    [transport, saving],
  );

  const refresh = useCallback(() => {
    if (transport !== null) void refreshExperimentalConnections(transport.key, transport.transport);
  }, [transport]);

  return {
    enabled: transport === null ? null : snapshot.enabled,
    error: snapshot.error,
    errorKind: snapshot.errorKind,
    saving,
    setEnabled,
    refresh,
  };
}
