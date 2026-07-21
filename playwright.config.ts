import { defineConfig, devices } from "@playwright/test";

/**
 * The browser smoke suite (e2e/), which exists to check the one thing the unit
 * tests cannot see: what paints on top of what. See e2e/app-shell.spec.ts.
 *
 * Chromium only, and deliberately so. This is a stacking guard, not a
 * cross-browser compatibility matrix, and every minute it costs is a minute
 * the unit suite does not have.
 */

/**
 * The dev server, not the production build: `npm run dev` serves over https
 * with a self-signed certificate (@vitejs/plugin-basic-ssl), and geolocation
 * — which every flow here starts from — is gated behind a secure context.
 */
const BASE_URL = "https://localhost:5173";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry on CI, none locally: a flake there costs a rerun of the whole
  // workflow, but a flake here should be seen rather than papered over.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    // The certificate is self-signed; without this every navigation fails.
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // A phone-first app, at the width the project verifies by hand
      // (CLAUDE.md): the sheet is full-width here, so the handle, the credit
      // bar and the list all compete for the same few hundred pixels.
      name: "mobile",
      use: { ...devices["Pixel 5"], viewport: { width: 375, height: 667 } },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
