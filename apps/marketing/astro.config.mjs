import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://doer.lagaryan.click",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
