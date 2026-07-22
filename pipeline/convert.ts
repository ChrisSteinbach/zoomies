import type { CoverageArea, Ring } from "../src/app/coverage";
import { haversineMeters } from "../src/app/geo";
import { DATASET_SCHEMA_VERSION } from "../src/app/offline-dataset";
import type { Dataset } from "../src/app/offline-dataset";
import {
  asBathingSpot,
  asDogPark,
  isBathingCandidate,
  isDogPark,
  toSpotTags,
} from "../src/app/osm-tags";
import type { SpotSkeleton } from "../src/app/osm-tags";
import type { DogSpot } from "../src/app/types";

/**
 * The build-time half of the offline data path (docs/spec.md §5, Option B):
 * pure translation from what the pipeline's tools hand over — osmium
 * export's GeoJSON, Geofabrik's .poly boundary — into the Dataset the app's
 * loader validates (offline-dataset.ts).
 *
 * Everything in this file is a pure function of its arguments. The I/O —
 * running osmium, reading files, stamping the clock — lives in
 * build-dataset.ts, so this half can be unit-tested to the same standard as
 * the app itself, offline and deterministic.
 *
 * Membership and translation are deliberately NOT decided here: they are
 * osm-tags.ts's, shared with the live Overpass provider, so the two data
 * paths cannot drift apart. This file adapts shapes (features in, spots
 * out), parses the boundary, and guards the result (assertDatasetSane).
 */

// ---------- The coverage boundary ----------

/**
 * Parses the Osmosis/Geofabrik .poly format into the app's CoverageArea.
 *
 * The format, one file per region (e.g. sweden.poly): the first line names
 * the polygon; then one or more sections, each opened by a ring-name line —
 * a leading "!" marks a hole — followed by "lon lat" coordinate lines and
 * closed by END; a final END closes the file. Coordinates are whitespace-
 * separated and often in Fortran-ish E-notation (1.088E+01), which
 * parseFloat reads as readily as plain decimals.
 *
 * The one trap is axis order: .poly stores longitude first, and the app's
 * Ring is [lat, lon] LATITUDE FIRST (coverage.ts). A silent transposition
 * would not error — it would put Sweden in the Indian Ocean and quietly
 * turn offline coverage off everywhere — so the swap happens here, once,
 * and the tests pin it with Sweden-shaped numbers whose latitude and
 * longitude ranges cannot be confused.
 *
 * Anything malformed throws rather than being skipped: this runs at build
 * time, where a loud failure costs one red Actions run, while a quietly
 * mangled boundary costs wrong answers in production.
 */
export function parsePoly(text: string): CoverageArea {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) throw new Error(".poly file is empty");

  const include: Ring[] = [];
  const exclude: Ring[] = [];

  // lines[0] is the polygon's name; CoverageArea has no use for it.
  let at = 1;
  while (at < lines.length) {
    const header = lines[at];
    if (header === "END") {
      if (at !== lines.length - 1) {
        throw new Error(".poly has content after its final END");
      }
      return { include, exclude };
    }

    const isHole = header.startsWith("!");
    at += 1;

    const ring: [number, number][] = [];
    while (at < lines.length && lines[at] !== "END") {
      ring.push(parsePolyCoordinate(lines[at]));
      at += 1;
    }
    if (at >= lines.length) {
      throw new Error(`.poly section "${header}" is never closed by END`);
    }
    at += 1; // consume the section's END

    (isHole ? exclude : include).push(ring);
  }

  throw new Error(".poly is missing its final END");
}

/** One "lon lat" line as the app's [lat, lon] point — the swap, in one place. */
function parsePolyCoordinate(line: string): [number, number] {
  const tokens = line.split(/\s+/);
  const lon = Number.parseFloat(tokens[0]);
  const lat = Number.parseFloat(tokens[1] ?? "");
  if (tokens.length !== 2 || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error(`.poly line "${line}" is not a "lon lat" coordinate pair`);
  }
  return [lat, lon];
}

// ---------- Features to spots ----------

/**
 * osmium export's GeoJSON features as the spots they qualify to be.
 *
 * Each feature is read once and may emit into both layers: a dog park
 * whose name contains "hundbad" (node 8693130278, "Hundbadplats
 * Rönningesjön") is genuinely both, and the two live queries would each
 * return it — the state machine dedupes visibility downstream, not here.
 * Which layers a feature belongs to, and what claim each spot makes, is
 * entirely osm-tags.ts's call (isDogPark, isBathingCandidate, asDogPark,
 * asBathingSpot); this function only reads the envelope.
 *
 * A feature whose identity or position cannot be established is dropped
 * whole: a pin that cannot be placed, or that nothing vouches for, is worse
 * than one result fewer (spec §3).
 *
 * The output is sorted by id then kind, so regenerating the dataset from
 * the same extract produces byte-identical, diffable JSON no matter what
 * order osmium happened to write the features in.
 */
export function convertFeatures(features: unknown[]): DogSpot[] {
  // First occurrence wins, exactly as the live path's toSpots dedupes its
  // union query. Duplicates are real here because area decoding maps
  // osmium's synthetic "a" features back onto way/relation ids: should a
  // closed way ever surface both as its own linestring and as the area
  // assembled from it, both spell the same ring, so the copies agree about
  // everything and which one wins cannot change the answer.
  const seen = new Set<string>();
  const spots: DogSpot[] = [];
  for (const feature of features) {
    for (const spot of toFeatureSpots(feature)) {
      const key = `${spot.kind} ${spot.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spots.push(spot);
    }
  }
  return spots.sort(compareSpots);
}

/**
 * Plain code-unit comparison, not localeCompare: the order only needs to be
 * stable and identical on every machine that runs the pipeline, and locale
 * collation is neither. (id, kind) is unique by the time sorting happens —
 * convertFeatures deduplicates on exactly that key.
 */
function compareSpots(a: DogSpot, b: DogSpot): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

/** One feature's contribution: zero, one or two spots. */
function toFeatureSpots(feature: unknown): DogSpot[] {
  if (!isRecord(feature)) return [];

  const id = toSpotId(feature.id);
  if (!id) return [];

  const point = featurePoint(feature.geometry);
  if (!point) return [];

  const tags = isRecord(feature.properties) ? feature.properties : {};
  const name = tags.name;
  const skeleton: SpotSkeleton = {
    id,
    // Absent, never a placeholder — same rule as the live path
    // (overpass.ts): many dog parks are genuinely unnamed, and the name is
    // otherwise OSM's verbatim; cleaning a bad one is an OSM edit's job.
    ...(typeof name === "string" && name !== "" ? { name } : {}),
    lat: point.lat,
    lon: point.lon,
    tags: toSpotTags(tags),
  };

  const spots: DogSpot[] = [];
  if (isDogPark(tags)) spots.push(asDogPark(skeleton));
  if (isBathingCandidate(tags)) {
    const bathing = asBathingSpot(skeleton, tags);
    if (bathing) spots.push(bathing);
  }
  return spots;
}

/**
 * osmium's `--add-unique-id=type_id` feature ids as the app's typed ids
 * ("node/123" | "way/456" | "relation/789") — the same identity the live
 * path builds from an element's type and id, so a spot keeps its id across
 * sources and the two can be deduplicated against each other.
 *
 * Four prefixes, not three. Nodes, ways and relations arrive as "n1"/"w2"/
 * "r3", but osmium *assembles areas* — closed ways carrying `area=yes`, and
 * multipolygon relations — into synthetic area objects numbered
 * 2×way-id and 2×relation-id+1, exported as "a<N>". Decoding that scheme
 * back to the underlying element is not optional: without it every
 * area-tagged park and every relation-mapped park silently vanishes from
 * the dataset. Found the hard way on the first real run — Vanadislundens
 * hundrastgård (way 703298765, tagged `area=yes`) exported as
 * "a1406597530" and dropped, while the live path kept returning it.
 *
 * Anything else reads as no identity at all, and the feature is dropped.
 */
const OSM_TYPE_BY_PREFIX: Readonly<Record<string, string>> = {
  n: "node",
  w: "way",
  r: "relation",
};

const OSMIUM_TYPE_ID = /^([nwra])(\d+)$/;

function toSpotId(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const match = OSMIUM_TYPE_ID.exec(id);
  if (!match) return undefined;
  const [, prefix, digits] = match;
  if (prefix !== "a") return `${OSM_TYPE_BY_PREFIX[prefix]}/${digits}`;

  // BigInt so the halving stays exact whatever size OSM ids grow to.
  const areaId = BigInt(digits);
  return areaId % 2n === 0n
    ? `way/${areaId / 2n}`
    : `relation/${(areaId - 1n) / 2n}`;
}

/** A GeoJSON position, in GeoJSON's own axis order. */
interface LonLat {
  lon: number;
  lat: number;
}

/**
 * Where a feature lives: the center of the bounding box over every position
 * in its geometry. For a Point that is the point itself; for everything
 * else — LineString, Polygon, MultiPolygon, GeometryCollection — it mirrors
 * Overpass's `out center;`, which is exactly the bbox center, so the two
 * data paths agree about where an area lives. An average-of-vertices
 * centroid here would put the same park in two different places depending
 * on which source answered.
 *
 * A geometry with no readable positions is no position at all, and the
 * caller drops the feature.
 */
function featurePoint(geometry: unknown): { lat: number; lon: number } | null {
  const positions = geometryPositions(geometry);
  if (!positions || positions.length === 0) return null;
  return bboxCenter(positions);
}

/** Every position in the geometry, or null when any of it is unreadable. */
function geometryPositions(geometry: unknown): LonLat[] | null {
  if (!isRecord(geometry)) return null;

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return null;
    const members: unknown[] = geometry.geometries;
    const all: LonLat[] = [];
    for (const member of members) {
      const positions = geometryPositions(member);
      if (!positions) return null;
      all.push(...positions);
    }
    return all;
  }

  const positions: LonLat[] = [];
  return collectPositions(geometry.coordinates, positions) ? positions : null;
}

/**
 * Walks a GeoJSON `coordinates` value of any nesting depth — a position, a
 * LineString's list, a Polygon's rings, a MultiPolygon's polygons — pushing
 * every position found. One malformed or non-finite entry poisons the whole
 * geometry: a bounding box computed over a subset of the real positions is
 * a wrong position, and position is non-negotiable (spec §3 — fewer results
 * beat wrong ones).
 */
function collectPositions(value: unknown, out: LonLat[]): boolean {
  if (!Array.isArray(value)) return false;
  const entries: unknown[] = value;
  if (entries.length === 0) return false;

  if (typeof entries[0] === "number") {
    // A position: [lon, lat], with an elevation sometimes trailing.
    const lon = entries[0];
    const lat = entries[1];
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) return false;
    out.push({ lon, lat });
    return true;
  }

  return entries.every((entry) => collectPositions(entry, out));
}

/** GeoJSON is lon-first; the emitted spot has lat/lon fields — swap here. */
function bboxCenter(positions: LonLat[]): { lat: number; lon: number } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const { lat, lon } of positions) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return {
    lat: roundCoord((minLat + maxLat) / 2),
    lon: roundCoord((minLon + maxLon) / 2),
  };
}

/**
 * Seven decimals is OSM's own precision (about a centimetre) — the same
 * rounding the live path applies when it prints a coordinate (formatCoord
 * in overpass.ts). It also swallows the float noise of the midpoint
 * division, so regeneration never churns the file on arithmetic dust.
 */
function roundCoord(value: number): number {
  return Number(value.toFixed(7));
}

// ---------- The published envelope ----------

export interface BuildDatasetInput {
  /** GeoJSON features from `osmium export --add-unique-id=type_id`. */
  features: unknown[];
  /** The region's .poly boundary text, e.g. Geofabrik's sweden.poly. */
  polyText: string;
  /** Stamped as Dataset.region, e.g. "europe/sweden". */
  region: string;
  /** ISO 8601. Passed in, never read from a clock here — the caller owns
   *  the clock, so these functions stay deterministic under test. */
  generatedAt: string;
}

/**
 * The complete published artifact, exactly as offline-dataset.ts validates
 * it. Attribution and license ride in-band because the file travels alone —
 * a raw URL, an IndexedDB copy — and must state its own ODbL obligations
 * wherever it lands (spec §4.1).
 */
export function buildDataset(input: BuildDatasetInput): Dataset {
  return {
    schema: DATASET_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    region: input.region,
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    coverage: parsePoly(input.polyText),
    spots: convertFeatures(input.features),
  };
}

// ---------- The publish gate ----------

/** The region whose expected contents this pipeline knows first-hand. */
export const SWEDEN_REGION = "europe/sweden";

/** Central Stockholm — the one city the spec requires to work (§2.1). */
const STOCKHOLM = { lat: 59.3293, lon: 18.0686 } as const;
const STOCKHOLM_RADIUS_M = 3_000;

/**
 * Sweden-wide floor for dog parks. Stockholm's central 3 km alone held 31
 * on 2026-07-21 and the country holds far more, so a total below 200 means
 * the osmium filter or the converter broke — not that Sweden lost its
 * parks over a weekend.
 */
const SWEDEN_MIN_DOG_PARKS = 200;

/**
 * Dog parks within 3 km of central Stockholm: field-validated at 31 on
 * 2026-07-21 against live Overpass. A drop below 20 means the filter,
 * converter or geometry broke, not Stockholm.
 */
const SWEDEN_MIN_STOCKHOLM_DOG_PARKS = 20;

/**
 * Country-wide bathing floor. The layer is honest-but-thin (spec §4.5.2) —
 * 4 spots were verified within 25 km of Stockholm alone on 2026-07-21 — so
 * five across the whole country is the weakest result worth publishing.
 */
const SWEDEN_MIN_BATHING_SPOTS = 5;

/**
 * The gate between a build and the publish step: throws, with a message
 * naming what broke, on any dataset that cannot plausibly be a real cut of
 * its region. The thresholds sit far below field-measured reality so that
 * genuine OSM drift never trips them — only a broken filter, converter or
 * boundary can get this far and fail here. A failure means no output file
 * and a red Actions run, which is the whole point: a dataset this wrong
 * must never reach the app, and the app's own loader would swallow the
 * damage silently (fewer pins, no error).
 */
export function assertDatasetSane(dataset: Dataset, region: string): void {
  if (dataset.spots.length === 0) {
    throw new Error(
      "Dataset sanity: no spots at all — the tags filter or the converter dropped everything",
    );
  }
  if (dataset.coverage.include.length === 0) {
    throw new Error(
      "Dataset sanity: coverage has no include rings — the .poly boundary parsed to nothing",
    );
  }

  // Thresholds are per-region knowledge. Another region's extract passes on
  // the generic gates alone until someone field-validates numbers for it.
  if (region !== SWEDEN_REGION) return;

  const parks = dataset.spots.filter((spot) => spot.kind === "dog_park");
  if (parks.length < SWEDEN_MIN_DOG_PARKS) {
    throw new Error(
      `Dataset sanity: ${SWEDEN_REGION} has only ${parks.length} dog parks, ` +
        `expected at least ${SWEDEN_MIN_DOG_PARKS} — the filter or converter broke`,
    );
  }

  const nearStockholm = parks.filter(
    (spot) => haversineMeters(STOCKHOLM, spot) <= STOCKHOLM_RADIUS_M,
  );
  if (nearStockholm.length < SWEDEN_MIN_STOCKHOLM_DOG_PARKS) {
    throw new Error(
      `Dataset sanity: only ${nearStockholm.length} dog parks within 3 km of ` +
        `central Stockholm, expected at least ${SWEDEN_MIN_STOCKHOLM_DOG_PARKS} ` +
        `(field-validated at 31 on 2026-07-21)`,
    );
  }

  const bathing = dataset.spots.filter((spot) => spot.kind === "bathing_spot");
  if (bathing.length < SWEDEN_MIN_BATHING_SPOTS) {
    throw new Error(
      `Dataset sanity: only ${bathing.length} bathing spots country-wide, ` +
        `expected at least ${SWEDEN_MIN_BATHING_SPOTS}`,
    );
  }
}

// ---------- Local guards, in the house style of overpass.ts ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
