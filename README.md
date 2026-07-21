# Zoomies

Find somewhere for your dog to run.

Given your GPS position, Zoomies shows the closest dog parks
(_hundrastgårdar_) sorted by distance, on a list and a map, with a
deep-link into your phone's maps app for directions. Later phases add dog
bathing spots (_hundbad_) and supplementary amenities.

Personal tool first: built for a dog owner in Stockholm. Stockholm
coverage is the bar the project is measured against. Everywhere else is a
bonus, and coverage will be uneven — the app should return fewer results
rather than confident wrong ones.

Data comes from [OpenStreetMap](https://www.openstreetmap.org/) —
© OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).

## Status

**Live at <https://chrissteinbach.github.io/zoomies/>** — installable, and
best opened on a phone, where the GPS is.

**Phase 1 (MVP) is complete and validated against Stockholm.** From a
position on Södermalm the app returns the nearest dog parks sorted by
distance, on a map and in a list, with a deep link into the platform maps
app. Geolocation denial, an unreachable Overpass, and genuinely-nothing-
nearby each produce their own honest state.

Spot-checked against OpenStreetMap: five results matched by name and by
distance to the metre. See `bd show zoomies-bgc.19` for the full record.

```bash
npm install
npm test          # lint + typecheck + unit tests
npm run dev       # https://localhost:5173 — and https://<lan-ip>:5173 from a phone
```

The dev server is https on purpose. The Geolocation API only works in a
secure context, so over plain http a phone never even sees the permission
prompt. The certificate is self-signed; accept the warning once.

Deploys are manual — run the **Deploy to GitHub Pages** workflow from the
Actions tab. Merging to `main` publishes nothing on its own.

**Phase 2 (the hundbad layer) is live**, and **phase 4's offline data path
is built** — pulled forward past phase 3, because field measurement put
98.6% of a 44-second cold start inside the live Overpass query (see
`bd show zoomies-lmf`). The app now answers from a weekly pre-built
dataset wherever that dataset can honestly cover the question, and falls
back to live Overpass everywhere else. Phase 3 (supplementary amenities)
remains open:

```bash
bd ready          # what is actionable now
bd show <id>      # detail on one item
```

## How it fits together

```
main.ts → compose-app.ts          the only place that knows concrete deps
            ├── state-machine.ts  pure transition(state, event) → effects
            ├── views             spot-list, spot-map, status-view, …
            └── expanding-search( offline-dataset( cache( fair-use( fallback( overpass ) ) ) ) )
```

The state machine is pure — no DOM, no fetch — so permission denial,
timeouts and empty results are ordinary function calls rather than states
you have to reproduce in a browser. The views take data and callbacks and
return DOM; none of them owns application state.

Data access is a decorator stack over one `PlaceProvider` that answers a
single query. Expanding radius decides _how far_ to look, the offline
dataset decides _from where_ — answering with a local scan when the
weekly-built dataset covers the whole query circle, deferring to the live
stack when it does not — the cache decides _whether to ask at all_, the
fair-use guard decides _how often_, and the fallback decides _whom_ —
trying the public Overpass mirror when the main instance says it is full —
each independently testable, and none of them inside the Overpass client.
Both layers (dog parks, and the phase-2 hundbad layer) run their own
expanding search over the one shared stack.

## The offline dataset

A weekly workflow (**Refresh dataset**, Mondays 03:00 UTC, also runnable
by hand from the Actions tab) downloads Geofabrik's Sweden extract, cuts
it down with `osmium`, converts what survives with the same rules the
live query uses, and force-pushes the result — one JSON file and an ODbL
notice — as the single commit of the `dataset` branch. The app fetches
that file once, keeps a copy in IndexedDB for offline reopens, and
answers queries with a linear scan whenever the query circle lies wholly
inside the dataset's coverage polygon. Outside it — or whenever the file
cannot be had — the live Overpass stack answers exactly as before.

Until the workflow's first run the branch does not exist, the fetch
404s, and every query stays on the live path: the designed rollout
state, not an error. The published file is a derived database of
OpenStreetMap, so it carries its attribution and ODbL share-alike terms
in-band and in the branch README (`docs/spec.md` §4.1).

To build the dataset locally (needs `osmium-tool` on PATH):

```bash
npm run data:build -- --pbf sweden.osm.pbf --poly sweden.poly --out dogspots-sweden.json
```

## Decisions made at project start

**Data access is interface-first.** All data goes through
`findDogParks(lat, lon, radiusM)` and `findBathingSpots(lat, lon, radiusM)`.
The MVP implemented them against the live
[Overpass API](https://overpass-api.de/); phase 4 dropped the offline
implementation (Geofabrik + osmium extract) in behind the same interface
without touching the UI — the payoff the seam was built for. What the
layers _mean_ in OSM tags lives once, in `osm-tags.ts`, shared by the live
query builder and the offline converter so the two sources cannot drift.
No Overpass-shaped types may leak through that seam.

**List and map, no radar.** Distance-sorted results with map pins, per the
spec. The compass/radar UI from the sibling project is deliberately not
carried over.

**No routing.** Deep-link to the platform maps app instead.

**Copy first, extract later.** Several modules are copied from
[tour-guide](https://github.com/ChrisSteinbach/tour-guide) (GPS watcher,
IndexedDB cache, drawer gesture, map picker, distance formatting) rather
than extracted into a shared package up front. Both codebases live with
their copies until it is clear which ones genuinely stayed shared — see
`zoomies-el7`, which has a mirror bead in tour-guide.

Notably _not_ carried over: the spherical Delaunay triangulation, tile
grid, and offline pipeline that tour-guide is built around. Those exist to
handle millions of geotagged Wikipedia articles. The entire global dog
dataset is a few thousand objects, where a linear scan with a plain
haversine is simpler and faster.

## Spec

[`docs/spec.md`](docs/spec.md) — the full specification, including the OSM
tags in use, the data-quality caveats that must be encoded rather than
assumed away, and the phase-1 exit criteria.
