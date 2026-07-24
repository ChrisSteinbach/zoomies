# Zoomies offline dataset

**dogspots.json** holds every dog park and dog bathing spot in
OpenStreetMap, planet-wide, pre-converted into the format the
[zoomies](https://github.com/ChrisSteinbach/zoomies) app reads. The
app fetches it from this branch's raw URL to answer nearby-spots
queries without a live Overpass round-trip.

The file is seeded from Geofabrik region extracts and then kept
current by replaying planet.osm.org daily replication diffs, with
geometry the diffs cannot carry repaired via the OSM editing API.

- Region: planet
- Generated: 2026-07-24

The data is © OpenStreetMap contributors. This file is a derived
database of OpenStreetMap and is published under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/);
share-alike applies to anything derived from it in turn.

This branch is a publish target, not history: each daily refresh
force-pushes a single orphan commit. The pipeline that generates
the file lives in the
[zoomies repository](https://github.com/ChrisSteinbach/zoomies).
