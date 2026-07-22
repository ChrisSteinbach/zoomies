import type { LatLon } from "./types";

/**
 * Whether an offline dataset can honestly answer a query (docs/spec.md §5).
 *
 * The offline dataset is built from a regional extract — Geofabrik's Sweden —
 * and a regional extract can only answer for positions whose whole query
 * circle lies inside the region it was cut to. The tempting shortcut, a
 * bounding-box test, fails exactly where it matters: Sweden's bounding box
 * contains Oslo and Copenhagen, so a bbox check would let the dataset tell a
 * traveller in either city "no dog parks nearby" with full confidence — the
 * confidently-wrong answer the spec forbids (§3). Coverage is therefore a
 * polygon test.
 *
 * The circle matters as much as the centre. A centre just inside the border
 * is covered, but its question may not be: a 25 km search from Malmö reaches
 * Denmark, and the extract would silently truncate that answer at the
 * frontier — parks missing, with nothing to say they are. So the rule is
 * strict: offline answers only when the whole circle fits inside coverage,
 * and every circle that crosses a boundary falls back to live Overpass.
 * Being conservative costs one network query; being generous costs a wrong
 * answer.
 *
 * The geometry is deliberately flat, and deliberately library-free.
 * Containment is topological, so ray casting works on raw degrees; boundary
 * distances are measured in a local equirectangular plane centred on the
 * query point, where at this app's radii (at most 25 km — SEARCH_RADII_M in
 * expanding-search.ts) the error against the sphere is far below 1%, and
 * only distances near the radius can change the answer. The model is not
 * valid across the antimeridian or near the poles; every region this app
 * would ship — Geofabrik country extracts around Europe — is nowhere near
 * either.
 */

/** The same sphere geo.ts measures on, so the two agree about a metre. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * A boundary ring: [lat, lon] pairs, LATITUDE FIRST.
 *
 * The order is the app's LatLon convention — and the opposite of GeoJSON's
 * lon-first. It matters more here than anywhere else in the codebase,
 * because rings are serialized into the dataset manifest, and a silent
 * order swap would not error: it would put Sweden in the Indian Ocean and
 * quietly turn offline coverage off everywhere. Say "lat, lon" out loud
 * when writing one down.
 *
 * The last point may repeat the first (.poly files traditionally close the
 * ring that way) or not; both spellings read as the same ring.
 */
export type Ring = readonly (readonly [number, number])[];

/**
 * The ground an offline dataset can answer for.
 *
 * Semantics follow Geofabrik's .poly files, which the dataset pipeline
 * parses: a point is covered when it is inside at least one include ring
 * and inside no exclude ring. Exclude rings are holes — ground the extract
 * was cut around, not merely ground beyond its edge.
 */
export interface CoverageArea {
  include: Ring[];
  exclude: Ring[];
}

/**
 * True iff the whole query circle lies inside coverage: the centre is
 * covered as {@link CoverageArea} defines it, and the distance from the
 * centre to every ring boundary — include and exclude alike — is at least
 * `radiusM`. An empty include list covers nothing, so the answer is false.
 *
 * Measuring against *every* boundary, not just the containing ring's, is
 * deliberately conservative: two include rings that touch would refuse
 * circles near their seam even though the union covers them. Proving that a
 * neighbouring ring picks up exactly where this one stops is a
 * union-coverage question this module does not need to answer — in general
 * a circle that reaches a boundary reaches uncovered ground, and the
 * exception buys nothing safe. Refusing costs one live query; it never
 * costs a wrong answer.
 */
export function circleWithinCoverage(
  center: LatLon,
  radiusM: number,
  coverage: CoverageArea,
): boolean {
  const covered =
    coverage.include.some((ring) => pointInRing(center, ring)) &&
    !coverage.exclude.some((ring) => pointInRing(center, ring));
  if (!covered) return false;

  return [...coverage.include, ...coverage.exclude].every(
    (ring) => distanceToRingBoundaryM(center, ring) >= radiusM,
  );
}

/**
 * Whether the point is inside the ring, by ray casting on raw degrees —
 * containment is a crossing count, so no projection is needed.
 *
 * The loop closes the ring implicitly with a last-to-first edge. When the
 * ring already repeats its first point, that extra edge is zero-length,
 * fails the straddle test, and contributes nothing — which is how both
 * spellings of a ring read the same.
 *
 * A point exactly on the boundary is ambiguous under ray casting, and
 * harmlessly so for both callers: here, such a point is at distance zero
 * from that boundary, so {@link circleWithinCoverage} refuses it for any
 * positive radius no matter which way the ambiguity falls; in
 * mapping-density.ts the rings are deliberate coarse approximations, so
 * either reading of an exactly-on-the-line point is within the heuristic's
 * tolerance. Exported for that second caller: same geometry, same [lat, lon]
 * convention, same disclaimers about the antimeridian and the poles.
 */
export function pointInRing(point: LatLon, ring: Ring): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i += 1) {
    const [latA, lonA] = ring[i];
    const [latB, lonB] = ring[i === 0 ? ring.length - 1 : i - 1];

    // Count edges that straddle the point's latitude and cross it east of
    // the point: an odd number of crossings means inside.
    if (latA > point.lat === latB > point.lat) continue;
    const crossingLon =
      lonA + ((point.lat - latA) * (lonB - lonA)) / (latB - latA);
    if (point.lon < crossingLon) inside = !inside;
  }
  return inside;
}

/**
 * Metres from the centre to the nearest point of the ring's boundary.
 *
 * Every vertex is projected into a local equirectangular plane centred on
 * the query point — x east, y north, in metres — and the answer is the
 * minimum point-to-segment distance there. Flat is enough: over the ≤ 25 km
 * that can decide an answer, the plane disagrees with the sphere by far
 * less than the margin any sane coverage boundary is drawn with.
 */
function distanceToRingBoundaryM(center: LatLon, ring: Ring): number {
  const metersPerLatRadian = EARTH_RADIUS_M;
  const metersPerLonRadian = EARTH_RADIUS_M * Math.cos(toRadians(center.lat));
  const points = ring.map(([lat, lon]) => ({
    x: toRadians(lon - center.lon) * metersPerLonRadian,
    y: toRadians(lat - center.lat) * metersPerLatRadian,
  }));

  let nearest = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i === 0 ? points.length - 1 : i - 1];
    const b = points[i];
    nearest = Math.min(nearest, originToSegmentM(a, b));
  }
  return nearest;
}

/** A ring vertex in the local plane, in metres from the query centre. */
interface PlanePoint {
  x: number;
  y: number;
}

/**
 * Distance from the origin — the query centre, by construction — to the
 * segment from `a` to `b`: project the origin onto the segment's line,
 * clamp to the segment, measure. A zero-length edge (the closing repeat of
 * a .poly ring) is just its point.
 */
function originToSegmentM(a: PlanePoint, b: PlanePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(a.x, a.y);

  const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSq));
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
