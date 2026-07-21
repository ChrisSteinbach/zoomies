# CLAUDE.md

**Zoomies** — find somewhere for your dog to run. Given a GPS position, it
shows the nearest dog parks (_hundrastgårdar_) as a distance-sorted list and
map pins, with a deep-link into the phone's maps app. Data is OpenStreetMap.
See `README.md` for the decisions taken at project start and `docs/spec.md`
for the full specification.

## Commands

```bash
npm test              # Lint + tests (runs npm run lint, then vitest run)
npm run test:watch    # Tests in watch mode
npm run test:coverage # Tests with coverage report
npm run lint          # Type-check + ESLint + Stylelint + Prettier check
npm run lint:fix      # Auto-fix ESLint + Stylelint + Prettier issues
npm run format        # Prettier check only
npm run format:fix    # Prettier auto-fix only
npm run dev           # Start Vite dev server (binds 0.0.0.0 for phone testing)
npm run build         # Production build → dist/
npm run preview       # Serve the production build locally
```

Run a single test file: `npx vitest run src/app/geo.test.ts`

Requires **Node.js 18+** (ES2022 target; `.nvmrc` pins 22).

## Pre-commit Hooks

`npm install` installs husky (via the `prepare` script), which owns
`core.hooksPath`. The beads hooks live inside `.husky/` alongside husky's own
— keep the `--- BEGIN/END BEADS INTEGRATION ---` markers intact when editing
them, and keep `npx lint-staged` as the first line of `.husky/pre-commit`.
lint-staged auto-fixes ESLint and Prettier on staged `.ts` files, Stylelint
and Prettier on staged `.css` files.

## The PlaceProvider seam

All place data goes through one interface:

```ts
findDogParks(lat, lon, radiusM): Promise<DogSpot[]>
```

The MVP implements it against the live Overpass API. A phase-4 offline
provider (Geofabrik + osmium extract) must drop in behind the same interface
without touching the UI, so:

- **No Overpass-shaped types may cross the seam.** No `elements`, no `tags`
  bags, no `type: "node" | "way"`, no Overpass ids leaking as identity. The
  provider translates Overpass JSON into `DogSpot` and nothing else escapes.
- Callers get domain types and domain errors. "Overpass timed out" is a
  provider detail; the UI sees a generic, retryable failure.
- Anything Overpass-specific (query building, response parsing, the expanding
  radius retry) belongs behind the provider, not in UI or state code.

Distances use the plain haversine in `src/app/geo.ts`. The global dog dataset
is a few thousand objects, so a linear scan is simpler and faster than any
spatial index — do not add a geometry library.

## Testing

Vitest with globals — use `describe`, `it`, `expect` without imports. Tests
live alongside source as `*.test.ts`. Tests needing a DOM start with
`// @vitest-environment jsdom`.

- **Test behavior, not implementation.** Assert on outcomes, not call
  sequences.
- **DAMP over DRY.** Inline setup so each test reads in isolation.
- **One behavior per test.** Each failure should name the exact scenario.
- **Pragmatic coverage.** Don't chase 100%. Every test should pay rent.
- **No network in unit tests.** Overpass responses come from fixtures; the
  provider is exercised against a fake fetch, never the real service. Tests
  must pass offline and give the same answer every run.

## Browser Verification

Tests do not prove a UI works. After any UI change, verify visually before
committing:

1. `npm run dev`
2. Open the app and walk through the affected flows
3. Check both desktop and mobile (375×667) widths — this is a phone-first app
4. Check interaction states, not just static layout

Geolocation needs a secure context: `localhost` is fine, but testing from a
phone over the LAN needs HTTPS.

## Data and Licensing

Data comes from OpenStreetMap, under
[ODbL](https://opendatacommons.org/licenses/odbl/). **Visible attribution
("© OpenStreetMap contributors") is a licensing obligation, not a nicety** —
it applies to both the place data and the map tiles, and it must stay visible
in the UI. Do not remove or hide it to clean up a layout. See `docs/spec.md`
§4.1 for what ODbL's share-alike requires if derived data is ever published.

OSM coverage is uneven and tagging is inconsistent — see `docs/spec.md` §4.5.
Encode those caveats rather than assuming them away: the app should return
fewer results rather than confident wrong ones.

## Issue Tracking

This project uses **beads** (`bd`), not markdown TODOs — see `AGENTS.md` for
the workflow and the session-completion checklist.

```bash
bd ready              # What is actionable now
bd show <id>          # Detail on one item
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
```

## Branching

**Always work on a feature branch**, never commit directly to `main`. Changes
land through pull requests.
