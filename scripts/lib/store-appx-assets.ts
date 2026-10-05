// Microsoft Store tile/logo assets (dependency-free spec + presence check).
//
// electron-builder v26 AppxTarget.computeUserAssets falls back to its vendored
// Electron sample images for every required logo the build resources do not
// provide, and those defaults fail the required WACK branding checks. The
// Store build therefore renders its own logos from the production Doer icon
// into the buildResources-relative "appx" dir during staging (see
// stageStoreAppxAssets); nothing is committed and no image code runs in
// tests. This module only describes the required set so the build, the CI
// unpack check, and the tests share one contract.

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
