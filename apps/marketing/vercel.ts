import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    // FORK (Doer): auto-deploy the site on push. Upstream disables this
    // because its release workflow deploys instead; the fork has no deploy
    // job, so Vercel Git integration owns doer.lagaryan.click.
    deploymentEnabled: true,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
};
