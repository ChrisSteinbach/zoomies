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
npm run dev       # http://localhost:5173
```

Phases 2–4 (hundbad, supplementary amenities, the offline data path) are
still open:

```bash
bd ready          # what is actionable now
bd show <id>      # detail on one item
```

## How it fits together

```
main.ts → compose-app.ts          the only place that knows concrete deps
            ├── state-machine.ts  pure transition(state, event) → effects
            ├── views             spot-list, spot-map, status-view, …
            └── expanding-search( cache( fair-use( overpass ) ) )
```

The state machine is pure — no DOM, no fetch — so permission denial,
timeouts and empty results are ordinary function calls rather than states
you have to reproduce in a browser. The views take data and callbacks and
return DOM; none of them owns application state.

Data access is a decorator stack over one `PlaceProvider` that answers a
single query. Expanding radius decides _how far_ to look, the cache decides
_whether to ask at all_, and the fair-use guard decides _how often_ — each
independently testable, and none of them inside the Overpass client.

## Decisions made at project start

**Data access is interface-first.** All data goes through
`findDogParks(lat, lon, radiusM)`. The MVP implements it against the live
[Overpass API](https://overpass-api.de/); a later offline implementation
(Geofabrik + osmium extract) drops in behind the same interface without
touching the UI. No Overpass-shaped types may leak through that seam.

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
