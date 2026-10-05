import type { EnvironmentId, GmailConnectionStatus } from "@t3tools/contracts";

/** One snapshot and operation lock for every Gmail control connected to a host. */
export function createGmailConnectionState() {
  let snapshot: { status: GmailConnectionStatus | null; busy: boolean } = {
    status: null,
    busy: false,
  };
  let operation = 0;
  let readVersion = 0;
  const listeners = new Set<() => void>();
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const current = (id: number) => operation === id && snapshot.busy;
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async (load: () => Promise<GmailConnectionStatus>) => {
      if (snapshot.busy) return;
      const version = ++readVersion;
      try {
        const status = await load();
        if (version === readVersion && !snapshot.busy) publish({ ...snapshot, status });
      } catch {
        // Keep the last known connection while temporarily offline.
      }
    },
    beginOperation: () => {
      if (snapshot.busy) return null;
      readVersion += 1;
      operation += 1;
      publish({ ...snapshot, busy: true });
      return operation;
    },
    isCurrent: current,
    setStatus: (id: number, status: GmailConnectionStatus) => {
      if (current(id)) publish({ ...snapshot, status });
    },
    endOperation: (id: number) => {
      if (current(id)) publish({ ...snapshot, busy: false });
    },
    cancelOperation: (id: number | null) => {
      if (id !== null && current(id)) {
        operation += 1;
        readVersion += 1;
        publish({ ...snapshot, busy: false });
      }
    },
  };
}

const connections = new Map<EnvironmentId | null, ReturnType<typeof createGmailConnectionState>>();

export function getGmailConnectionState(environmentId: EnvironmentId | null) {
  let state = connections.get(environmentId);
  if (!state) {
    state = createGmailConnectionState();
    connections.set(environmentId, state);
  }
  return state;
}
