import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

const THEME_COLOR = "#2e7d32";

export default defineConfig(() => {
  /**
   * The app is served from the apex custom domain https://big-zoomies.com/,
   * so every built URL — assets, manifest, service-worker scope — resolves
   * against the site root. `base` is "/" for dev, preview and the production
   * build alike, so preview mirrors production exactly.
   *
   * It was once "/zoomies/", when GitHub Pages served this repo as a *project*
   * page at chrissteinbach.github.io/zoomies/ and every URL had to carry that
   * prefix. The custom domain serves from the root; public/CNAME is what pins
   * the domain onto each Pages deploy.
   */
  const base = "/";

  return {
    base,
    server: {
      // Bind all interfaces so the app can be opened from a phone on the same
      // network — this is a GPS app, so real testing happens on a phone.
      host: "0.0.0.0",
    },
    preview: {
      host: "0.0.0.0",
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    plugins: [
      // HTTPS on the dev server, with a self-signed certificate.
      //
      // Not a nicety: the Geolocation API is gated behind a secure context, so
      // over plain http:// a phone on the LAN never even sees the permission
      // prompt — the call just fails, and the app can only report that it does
      // not know where you are. `localhost` is exempt, which is why this is
      // invisible on a desktop and breaks only on the device the app is for.
      //
      // The certificate is self-signed, so the phone shows a warning once per
      // machine; accept it and geolocation behaves as it will in production.
      basicSsl(),
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
