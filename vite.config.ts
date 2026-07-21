import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * GitHub Pages serves this repo as a *project* page — `ChrisSteinbach/zoomies`
 * lands on https://chrissteinbach.github.io/zoomies/ — so every built URL
 * (assets, manifest, service worker scope) has to carry the `/zoomies/`
 * prefix or the deployed site 404s on all of them.
 *
 * The dev server has no such prefix, so it keeps serving from the root and
 * `npm run dev` is unaffected. Preview does take the prefix: it serves the
 * built files, whose URLs already carry it, and without it every asset there
 * would 404 into the SPA fallback instead.
 */
const PAGES_BASE = "/zoomies/";

const THEME_COLOR = "#2e7d32";

export default defineConfig(({ command, isPreview }) => {
  const base = command === "build" || isPreview ? PAGES_BASE : "/";

  return {
    base,
    server: {
      // Bind all interfaces so the app can be opened from a phone on the same
      // network — this is a GPS app, so real testing happens on a phone.
      host: "0.0.0.0",
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    plugins: [
      VitePWA({
        // A new build takes over as soon as the browser sees it, so an
        // installed copy can't get stuck on a stale app shell.
        registerType: "autoUpdate",
        // Registration is explicit in src/main.ts; don't also inject a
        // script tag, or the app would register twice.
        injectRegister: null,
        // The icons live in public/, so `globPatterns` below already
        // precaches them. Letting the plugin add them a second time makes
        // every icon a duplicate precache entry.
        includeManifestIcons: false,
        manifest: {
          id: base,
          name: "Zoomies",
          short_name: "Zoomies",
          description: "Find somewhere for your dog to run.",
          // Both track `base`: an installed app must launch inside the
          // deployed subpath, and the service worker must not claim URLs
          // outside it (other projects share the github.io origin).
          start_url: base,
          scope: base,
          display: "standalone",
          orientation: "portrait",
          theme_color: THEME_COLOR,
          background_color: "#f5f5f5",
          lang: "en",
          // Icon paths stay relative so they resolve against the manifest's
          // own URL, which already carries `base`. The PNGs are rasterised
          // from the SVGs next to them in public/.
          icons: [
            {
              src: "icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
            {
              src: "icon-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "icon-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              // Full-bleed variant: Android crops adaptive icons to its own
              // shape, so the artwork sits inside the 80% safe zone.
              src: "icon-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // The whole app shell is precached: this app is expected to be
          // opened outdoors, on a phone, on a bad connection. The manifest
          // itself is not listed — the plugin precaches that one already.
          globPatterns: ["**/*.{js,css,html,svg,png}"],
          runtimeCaching: [
            {
              // Overpass responses are NOT cached here. The app's own
              // IndexedDB cache owns data freshness; a second cache in the
              // service worker would mean two TTLs and no single answer to
              // "how old is this result?". NetworkOnly makes that a decision
              // rather than an oversight — and it covers the public mirrors
              // (overpass-api.de, overpass.kumi.systems, ...), not just one
              // host, so switching endpoints can't quietly start caching.
              urlPattern: /^https:\/\/[^/]*overpass[^/]*\//,
              handler: "NetworkOnly",
            },
            {
              // Map tiles are the expensive repeat fetch: immutable bytes,
              // re-requested every time the map moves back over ground the
              // user has already seen.
              urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\//,
              handler: "CacheFirst",
              options: {
                cacheName: "osm-tiles",
                expiration: {
                  maxEntries: 500,
                  maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                },
                // Tiles are fetched no-cors by Leaflet, so successful
                // responses arrive opaque with status 0.
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
  };
});
