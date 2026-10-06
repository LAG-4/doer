import type { EnvironmentId, GmailConnectionStatus } from "@t3tools/contracts";

/** Where the selected computer can be reached from, for honest host guidance. */
export function resolveGmailHostAccess(input: {
  readonly httpBaseUrl: string | null;
  readonly targetTag: string | null;
  readonly computerLabel: string | null;
  readonly isLoopback: (hostname: string) => boolean;
}): { readonly reachable: boolean; readonly onHost: boolean; readonly guidance: string | null } {
  if (input.httpBaseUrl === null) return { reachable: false, onHost: false, guidance: null };
  let hostname: string;
  try {
    hostname = new URL(input.httpBaseUrl).hostname;
  } catch {
    return { reachable: false, onHost: false, guidance: null };
  }
  // The Google sign-in finishes on the host itself (loopback callback), so a
  // browser viewing a remote computer must never pretend it can connect here.
  // A loopback URL alone is not proof: SSH tunnels and forwarded transports
  // serve remote computers over localhost too. Only the primary local target
  // over loopback means this browser runs on the host.
  if (input.targetTag === "PrimaryConnectionTarget" && input.isLoopback(hostname)) {
    return { reachable: true, onHost: true, guidance: null };
  }
  const computer = input.computerLabel?.trim() ? input.computerLabel.trim() : "that computer";
  return {
    reachable: true,
    onHost: false,
    guidance: `Open Doer on ${computer} to connect Gmail. The Google sign-in must finish on that computer.`,
  };
}

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
