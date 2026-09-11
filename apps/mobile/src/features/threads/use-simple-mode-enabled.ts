import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveSimpleModeEnabled } from "./simple-mode";

/**
 * Resolved Simple mode state: on unless the device explicitly opted out
 * (Settings → General). Every git-control consumer must read through this
 * rather than the raw preference, which is undefined until explicitly chosen.
 */
export function useSimpleModeEnabled(): boolean {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  return resolveSimpleModeEnabled({
    preference: loaded ? preferencesResult.value.simpleModeEnabled : undefined,
    preferencesLoaded: loaded,
  });
}
