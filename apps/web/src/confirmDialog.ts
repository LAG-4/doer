import type {
  ConfirmDialogOptions,
  ConfirmDialogResult,
  ConfirmDialogVariant,
} from "@t3tools/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly dontAskAgainLabel: string | null;
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly dontAskAgainLabel: string | null;
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly dontAskAgainLabel: string | null;
  readonly resolve: (result: ConfirmDialogResult) => void;
};

export const DEFAULT_DONT_ASK_AGAIN_LABEL = "Don't ask again";

function resolveDontAskAgainLabel(options?: ConfirmDialogOptions): string | null {
  if (!options?.dontAskAgain) return null;
  const label = options.dontAskAgain.label?.trim();
  return label ? label : DEFAULT_DONT_ASK_AGAIN_LABEL;
}

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  const result = { confirmed, dontAskAgain: false } satisfies ConfirmDialogResult;
  activeConfirmation?.resolve(result);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(result);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that can present themed confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * Requests a themed confirmation with a "don't ask again" checkbox when a
 * host is mounted. An undefined result means no themed host is currently
 * available.
 */
export function requestConfirmDialogWithDontAskAgain(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<ConfirmDialogResult> | undefined {
  if (registeredHostCount === 0) return undefined;

  const variant = options?.variant ?? "default";
  const dontAskAgainLabel = resolveDontAskAgainLabel(options);
  const confirmation = new Promise<ConfirmDialogResult>((resolve) => {
    const pending = {
      message,
      variant,
      dontAskAgainLabel,
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({ status: "confirming", message, variant, dontAskAgainLabel });
  });

  return confirmation;
}

/**
 * Requests a themed confirmation when a host is mounted. An undefined result
 * means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  const confirmation = requestConfirmDialogWithDontAskAgain(message, options);
  if (!confirmation) return undefined;
  return confirmation.then((result) => result.confirmed);
}

export function respondToConfirmDialog(confirmed: boolean, dontAskAgain = false): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve({ confirmed, dontAskAgain: confirmed && dontAskAgain });
  publish({
    status: "closing",
    message: state.message,
    variant: state.variant,
    dontAskAgainLabel: state.dontAskAgainLabel,
  });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({
    status: "confirming",
    message: next.message,
    variant: next.variant,
    dontAskAgainLabel: next.dontAskAgainLabel,
  });
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
