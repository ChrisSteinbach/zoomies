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

Planning. No code yet. The work is tracked in beads:

```bash
bd ready          # what is actionable now
bd show <id>      # detail on one item
```

Start at `zoomies-bgc.1` (scaffold the toolchain) — everything else is
blocked on it.

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
