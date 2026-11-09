// Microsoft Store tile/logo assets (dependency-free spec + presence check).
//
// electron-builder falls back to vendored Electron sample images that fail
// WACK branding checks, so the Store build renders its own logos from the
// production Doer icon into the buildResources-relative "appx" dir.

export interface StoreAppxAssetSpec {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export const STORE_APPX_ASSETS: ReadonlyArray<StoreAppxAssetSpec> = [
  { name: "StoreLogo.png", width: 50, height: 50 },
  { name: "Square150x150Logo.png", width: 150, height: 150 },
  { name: "Square44x44Logo.png", width: 44, height: 44 },
  { name: "Wide310x150Logo.png", width: 310, height: 150 },
];

/** Pure set-difference: which required asset names are absent. */
export function findMissingStoreAppxAssets(
  presentNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const present = new Set(presentNames);
  return STORE_APPX_ASSETS.map((asset) => asset.name).filter((name) => !present.has(name));
}
