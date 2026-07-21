import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  server: {
    // Bind all interfaces so the app can be opened from a phone on the same
    // network — this is a GPS app, so real testing happens on a phone.
    host: "0.0.0.0",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
