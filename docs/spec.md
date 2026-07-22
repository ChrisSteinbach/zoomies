# Dog Spot Finder — High-Level Specification

A handoff spec for implementation. Describes the goal, the recommended
architecture, and where/how to get the data. Implementation details
(language, framework, hosting) are left open unless stated.

---

## 1. Purpose

An app that, given the user's current GPS position, finds the **closest
dog parks** (Swedish: *hundrastgårdar*) and, secondarily, **places where
dogs can bathe** (*hundbad*).

- **Primary user:** a single dog owner living in Stockholm, Sweden.
  This is a personal tool first; anything beyond that is a bonus.
- **Primary geography:** Stockholm and its surrounding municipalities.
- **Stretch geography:** anywhere in the world where data exists.
  Global coverage will be uneven and incomplete — that is acceptable.
  The app should degrade gracefully (fewer/no results, never wrong
  results presented confidently).

## 2. Hard Requirements

1. **Stockholm must be well covered.** If dog parks in the Stockholm
   region cannot be found reliably, the project has failed its core
   purpose.
2. Results must be sorted by distance from the user's current position.
3. Data licensing must permit this use (see §4.1 — it does).

## 3. Scope

### In scope (MVP)
- Locate user via device GPS / browser Geolocation API.
- Query dog parks within a radius of the user's position.
- Sort by straight-line (haversine) distance; show name (when mapped),
  distance, and position on a map and/or in a list.
- Deep-link a result into the platform's navigation app (Google/Apple
  Maps URL scheme) rather than building routing ourselves.

### In scope (subsequent phases)
- Dog bathing spots layer (see §4.3 — data is sparser; needs fallbacks).
- Supplementary dog amenities (see §4.4): waste bins/bag dispensers,
  dog tie-up spots, dog-friendly drinking water, leash rules on parks.
- Global operation using the same query patterns.

### Out of scope
- **Stockholm Stad open data (WMS "Hundrastgård" layer)** — exists, but
  deliberately excluded from this build.
- **Google Places API** — has a `dog_park` place type, but excluded
  (cost, caching/redistribution restrictions).
- Turn-by-turn routing, accounts/login, social features, reviews.

## 4. Data Source: OpenStreetMap (the only data source)

OSM is the single source of truth for this app. It is the only dataset
with one consistent global query interface, and the Swedish OSM
community is active, so Stockholm coverage of `leisure=dog_park` is
good.

### 4.1 Licensing
- OSM data is © OpenStreetMap contributors, licensed **ODbL**.
- Requirements: visible attribution ("© OpenStreetMap contributors")
  in the app; if we publish a derived *database*, it must be
  share-alike under ODbL. Using the data inside the app is fine.

### 4.2 Primary feature: dog parks

| Tag | Meaning |
|---|---|
| `leisure=dog_park` | Designated area (often fenced) where dogs may be exercised off-leash. Approved, well-established, mapped worldwide. |

- Mapped as **nodes or areas (ways/relations)**. For areas, use the
  computed centroid for distance calculations (Overpass `out center;`
  provides this).
- Useful subtags when present: `name`, `barrier=fence` /
  `fenced=yes`, `surface`, `lit`, `dog_exercise=*` (agility equipment).

### 4.3 Secondary feature: dog bathing spots

There is **no single primary tag** for hundbad. Coverage in OSM is
sparse even in Sweden, because the dog-related subtag is often omitted.
Query as a union of patterns:

| Pattern | Meaning |
|---|---|
| `leisure=bathing_place` + `dog=yes` or `dog=designated` | Natural-water bathing spot where dogs are allowed/intended |
| `natural=beach` + `dog=yes` or `dog=designated` | Beach where dogs are allowed / a dog beach |
| `leisure=swimming_area` + `dog=yes/designated` | Designated swimming water |
| `name~"hundbad"` (case-insensitive) | **Sweden-specific fallback:** many hundbad are mapped as generic features with "hundbad" in the name and no `dog=*` tag. This regex catches them. |

Notes:
- `dog=designated` means the feature is *specifically intended for
  dogs* (a dog beach); `dog=yes` merely means dogs are allowed.
- Expect misses. The correct long-term fix is contributing missing
  hundbad to OSM (which improves both the app and the commons) —
  worth mentioning in the app UI, not building tooling for in MVP.

### 4.4 Supplementary features (later phases)

| Tag | Feature |
|---|---|
| `amenity=waste_basket` + `waste=dog_excrement` | Dog waste bin |
| `amenity=vending_machine` + `vending=excrement_bags` | Poop-bag dispenser |
| `amenity=dog_parking` | Tie-up spot outside shops |
| `amenity=drinking_water` + `dog=yes` | Dog-friendly water |
| `dog=*` on `leisure=park` etc. | Leash rules: `yes` / `no` / `leashed` / `unleashed` |
| `dog:conditional=*` | Seasonal rules, e.g. `no @ (Jun 1-Aug 31)` |
| `amenity=veterinary`, `shop=pet` | Vets and pet shops |

### 4.5 Known data-quality caveats — encode these assumptions

1. **`leisure=dog_park` is trustworthy and dense** in Stockholm,
   Scandinavia, Germany, US, Canada, UK, Ireland, Australia,
   New Zealand. Sparse elsewhere.
2. **Bathing data is thin.** Treat the hundbad layer as best-effort;
   the name-regex fallback (§4.3) matters in Sweden.
3. **OSM records existence, not current legality.** In Stockholm (and
   many Swedish municipalities) dogs are banned from public beaches
   roughly **1 June – 31 August**, with signed exceptions. Where a
   feature carries `dog:conditional`, respect it; where it doesn't,
   the UI should say "verify signage on site" rather than assert
   permission.
4. Features can be nodes, ways, or relations — always handle all
   three (`nwr` in Overpass).

## 5. Getting the Data

### Option A — Live Overpass API queries (recommended for MVP)

The Overpass API is a free, public, read-only query service over OSM.

- Main endpoint: `https://overpass-api.de/api/interpreter`
  (public mirrors exist, e.g. `overpass.kumi.systems`; make the
  endpoint configurable).
- **Fair use:** it is a shared community service. Cache responses,
  keep concurrency ≤ 2, and never poll. A personal-use app is far
  below any limit; a popular app would need Option B or a self-hosted
  Overpass instance.

**Dog parks near a position** (radius in meters, POST the query as
`data=`):

```overpassql
[out:json][timeout:25];
nwr["leisure"="dog_park"](around:{RADIUS},{LAT},{LON});
out center;
```

**Bathing spots near a position** (union of §4.3 patterns):

```overpassql
[out:json][timeout:25];
(
  nwr["leisure"="bathing_place"]["dog"~"^(yes|designated)$"](around:{RADIUS},{LAT},{LON});
  nwr["natural"="beach"]["dog"~"^(yes|designated)$"](around:{RADIUS},{LAT},{LON});
  nwr["leisure"="swimming_area"]["dog"~"^(yes|designated)$"](around:{RADIUS},{LAT},{LON});
  nwr["name"~"hundbad",i](around:{RADIUS},{LAT},{LON});
);
out center;
```

Response handling:
- `out center;` returns `lat`/`lon` for nodes and a `center` object
  for ways/relations — normalize both to a single point per feature.
- Deduplicate (the union query can match a feature twice).
- Start with radius ≈ 3 km and expand (e.g. 3 → 10 → 25 km) until
  N results are found, rather than one huge query.

### Option B — Offline extracts (for global scale / independence)

For reliability, offline use, or global scale without hammering a
shared service:

1. Download a regional extract from **Geofabrik**
   (`https://download.geofabrik.de/` — e.g.
   `europe/sweden-latest.osm.pbf`, or the full planet for global).
2. Filter to the tags in §4 with **`osmium tags-filter`**. The
   result is tiny — dog-related features for all of Sweden are a few
   thousand objects at most, and even globally it's small enough to
   ship as a static file.
3. Convert to the app's format: GeoJSON, or load into SQLite/PostGIS
   for spatial queries.
4. Refresh on a schedule. Dog parks change rarely — **weekly or even
   monthly regeneration is plenty.**

### Recommendation

**Start with Option A** (live Overpass + client/server-side caching).
Put data access behind a small interface (`findDogParks(lat, lon,
radius)`, `findBathingSpots(...)`) so Option B can replace it later
without touching the UI. Option B becomes attractive the moment the
app has more than a handful of users or needs to work offline.

## 6. Recommended Architecture

```
┌────────────────────────────┐
│  Client (PWA suggested)    │  Geolocation API → lat/lon
│  - map view + result list  │
│  - distance sort (haversine)
└────────────┬───────────────┘
             │  findDogParks(lat, lon, r)
┌────────────▼───────────────┐
│  Data access layer         │  MVP: Overpass HTTP client + cache
│  (interface, swappable)    │  Later: local extract (Geofabrik+osmium)
└────────────┬───────────────┘
             │
      Overpass API  /  local dataset
```

Guidance:
- **A PWA is a natural fit**: one codebase, works on phone where GPS
  queries actually happen, installable, and the whole MVP can run
  client-side (Geolocation API → Overpass fetch → haversine sort →
  Leaflet/MapLibre map with OSM tiles). No backend is strictly
  required for a personal-use MVP.
- If a backend is added later, its main jobs are caching Overpass
  responses (protect the shared service, speed up repeat queries) and
  serving the Option-B dataset.
- Map tiles: OSM raster tiles or any provider; attribution
  requirement applies here too.
- Distance: haversine is sufficient. Do not build routing; deep-link
  to the platform's maps app for "take me there".

## 7. Core Functional Requirements (MVP)

1. On open, request geolocation; handle denial with a manual
   location-picker fallback.
2. Fetch dog parks within an expanding radius until ≥ 5 results or a
   max radius (~25 km) is reached.
3. Display results as a distance-sorted list and as map pins; each
   result shows name (or "Unnamed dog park"), distance, and tags of
   interest if present (leash status, fenced, lit, surface).
4. Tapping a result offers "open in maps" navigation deep-link.
5. Show OSM attribution.
6. Errors (Overpass down/timeout) fail visibly and politely; offer
   retry. Cache the last successful result set for the session.

## 8. Phasing

| Phase | Deliverable |
|---|---|
| 1 | MVP: nearest dog parks from GPS, Stockholm-validated |
| 2 | Hundbad layer with the §4.3 union query + "verify on site" caveat |
| 3 | Supplementary amenities (§4.4) as toggleable map layers |
| 4 | Global hardening: Option B data path, offline support |

## 9. Open Questions (decide during implementation)

- Client stack for the PWA (any modern framework or vanilla is fine;
  Leaflet vs MapLibre for the map).
- Radius-expansion tuning and result count targets.
- Whether Phase 1 ships entirely client-side (no backend) — default
  yes unless a reason emerges.
- How to present features found only via the `hundbad` name-regex
  (lower confidence than explicitly tagged features?).

## 10. Validation Plan (Phase 1 exit criteria)

- From a position in central/southern Stockholm, the app returns
  multiple known hundrastgårdar with plausible distances.
- Spot-check 5 results against OSM's own map (`openstreetmap.org`) —
  positions and names match.
- Geolocation denial, Overpass timeout, and zero-result cases all
  produce sensible UI states.
