import { adoptSilentTags } from "./osm-tags";
import { haversineMeters } from "./geo";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

/**
 * OSM double-mapping: the same real place, mapped twice.
 *
 * A common OSM pattern maps a facility both as an area (a `way` or
 * `relation` tracing its outline) and as a POI `node` sitting beside or
 * inside that outline — often a leftover from before the area existed, or a
 * second mapper who did not notice the first. Both carry the same
 * `leisure=dog_park` tag, so both survive the query untouched: the same real
 * park comes back as two {@link DogSpot} rows with two different distances
 * and two overlapping map pins.
 *
 * Measured against the published dataset (30,322 spots, 2026-07-23): 239
 * node-vs-area same-kind pairs within 50 m of each other — roughly 0.8% of
 * all spots — 44 of them sharing a name and 154 with at least one side
 * unnamed. The bead that prompted this module, zoomies-hrm, is one of the
 * 44: "Monteliusvägens hundrastgård" lists as both `node/13245355311` and
 * `way/1443425101`, ~12.4 m apart.
 *
 * The fix has to be conservative rather than clever: two nearby, same-named,
 * same-kind features are not proof of double-mapping — two genuine sections
 * of one large facility look exactly the same from here. The app should
 * return fewer results rather than confident wrong ones (docs/spec.md §4.5),
 * so {@link collapseDoubleMapped} only fires when BOTH distance and name
 * agree, and only ever folds a node into an area, never an area into
 * another area and never a node into another node.
 */

/**
 * How close a node has to sit to an area before the two are even
 * considered the same place.
 *
 * 50 m comfortably covers the 12.4 m Monteliusvägen pair and the rest of the
 * measured same-name node/area pairs, while staying well short of the ~134 m
 * that separates the two genuine "Dog Park" sections used as a
 * never-collapse fixture below — the margin the conservative rule needs.
 */
export const DOUBLE_MAPPING_COLLAPSE_DISTANCE_M = 50;

/** A node's nearest in-range, same-kind, name-agreeing area, with the
 *  distance that made it win — kept so the merge step never recomputes it. */
interface CollapseTarget {
  area: DogSpot;
  distance: number;
}

/** A node about to be folded into an area, alongside the distance that
 *  decided both whether it qualified and the order it merges in. */
interface PendingCollapse {
  node: DogSpot;
  distance: number;
}

/**
 * Collapses double-mapped node/area pairs into single rows.
 *
 * Pure: never mutates the input array or any spot it contains — the offline
 * dataset hands out its own in-memory objects by reference, and mutating one
 * here would corrupt every future query against that dataset.
 *
 * Rule, applied per node: it collapses onto a same-kind area within
 * {@link DOUBLE_MAPPING_COLLAPSE_DISTANCE_M} metres whose name agrees — both
 * defined and equal after `.trim().toLowerCase()`, or at least one side
 * unnamed. A node with several qualifying areas collapses onto the nearest
 * (ties broken by the lexicographically smaller area id), and only that one
 * area adopts from it. The area is always the survivor — OSM considers the
 * area geometry primary, so its position is the better distance anchor — and
 * its id, lat/lon, kind and provenance never change. Areas never collapse
 * onto areas and nodes never collapse onto nodes: two same-name areas near
 * each other are plausibly two genuine sections of one facility, and an area
 * is never dropped.
 *
 * Where one or more nodes collapse onto an area, the merged row is a new
 * object built by folding the dropped nodes into the area in a fixed order
 * — nearest first, ties by node id — so the result never depends on the
 * order spots arrived in:
 *   - `name`: the area's, unless the area is unnamed, in which case the
 *     first (nearest) dropped node's name that is defined — an "Unnamed dog
 *     park" row next to a dropped named node would be strictly worse.
 *   - `tags`: {@link adoptSilentTags} folded over the dropped nodes, so the
 *     area's surveyed tags win and only its silences are filled.
 *   - `seasonal`: the area's, or the first dropped node's if the area is
 *     silent — the same adopt-where-silent policy as tags.
 *   - `provenance`: always the area's. It is never silent (every
 *     {@link DogSpot} carries one), so nothing is ever adopted here.
 *
 * Untouched spots — areas nothing collapsed onto, and nodes that found no
 * qualifying area — come back as the same object references; nothing is
 * copied unless a merge actually happened.
 *
 * The result is sorted by `id` (ties by `kind`) regardless of input order.
 * `PlaceProvider` promises its results unsorted, and the UI re-sorts by live
 * distance downstream anyway, so imposing this order costs nothing — and it
 * is what makes this a pure function of the *set* of spots rather than of
 * the sequence they happened to arrive in, which is what the determinism
 * tests below pin down.
 */
export function collapseDoubleMapped(spots: DogSpot[]): DogSpot[] {
  const areas = spots.filter((spot) => isArea(spot.id));

  // Keyed by object, not id: an id is only unique per kind — the dataset
  // stores a park that is also a named hundbad once per kind, same id — so
  // in a mixed-kind list an id key would leak one kind's adoptions onto the
  // other kind's twin.
  const collapsesByArea = new Map<DogSpot, PendingCollapse[]>();
  const collapsedNodes = new Set<DogSpot>();

  for (const spot of spots) {
    if (!isNode(spot.id)) continue;

    const target = nearestCollapseTarget(spot, areas);
    if (!target) continue;

    const pending = collapsesByArea.get(target.area) ?? [];
    pending.push({ node: spot, distance: target.distance });
    collapsesByArea.set(target.area, pending);
    collapsedNodes.add(spot);
  }

  const result: DogSpot[] = [];
  for (const spot of spots) {
    if (collapsedNodes.has(spot)) continue;

    const pending = collapsesByArea.get(spot);
    if (pending && pending.length > 0) {
      result.push(
        mergeAreaWithCollapsedNodes(spot, orderPendingCollapses(pending)),
      );
      continue;
    }

    result.push(spot);
  }

  return result.sort(compareSpots);
}

function isNode(id: string): boolean {
  return id.startsWith("node/");
}

function isArea(id: string): boolean {
  return id.startsWith("way/") || id.startsWith("relation/");
}

/** Whether two OSM names refer to the same place: both say the same thing,
 *  or one of them says nothing at all. */
function namesAgree(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function nearestCollapseTarget(
  node: DogSpot,
  areas: DogSpot[],
): CollapseTarget | undefined {
  let best: CollapseTarget | undefined;

  for (const area of areas) {
    if (area.kind !== node.kind) continue;

    const distance = haversineMeters(node, area);
    if (distance > DOUBLE_MAPPING_COLLAPSE_DISTANCE_M) continue;
    if (!namesAgree(node.name, area.name)) continue;

    const better =
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && area.id < best.area.id);
    if (better) best = { area, distance };
  }

  return best;
}

/** Nearest first, ties by node id — the fixed merge order that keeps
 *  `collapseDoubleMapped` deterministic regardless of input order. */
function orderPendingCollapses(pending: PendingCollapse[]): DogSpot[] {
  return [...pending]
    .sort(
      (a, b) => a.distance - b.distance || compareStrings(a.node.id, b.node.id),
    )
    .map((collapse) => collapse.node);
}

function mergeAreaWithCollapsedNodes(
  area: DogSpot,
  orderedNodes: DogSpot[],
): DogSpot {
  const name =
    area.name ?? orderedNodes.find((node) => node.name !== undefined)?.name;
  const tags = orderedNodes.reduce(
    (merged, node) => adoptSilentTags(merged, node.tags),
    area.tags,
  );
  const seasonal = orderedNodes.reduce(
    (merged, node) => merged ?? node.seasonal,
    area.seasonal,
  );

  return {
    ...area,
    tags,
    ...(name !== undefined ? { name } : {}),
    ...(seasonal !== undefined ? { seasonal } : {}),
  };
}

function compareSpots(a: DogSpot, b: DogSpot): number {
  return compareStrings(a.id, b.id) || compareStrings(a.kind, b.kind);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * A {@link PlaceProvider} decorator that applies {@link collapseDoubleMapped}
 * to whatever the inner provider answers.
 *
 * Sits outermost in the provider stack — around `withOfflineDataset` and
 * whatever wraps the live client — so dataset-served, live-served and cached
 * results all pass through the same rule before anything downstream sees
 * them. Each call collapses one kind at a time, because `findDogParks` and
 * `findBathingSpots` are asked separately: the parks+bathing view the UI
 * builds by combining both calls can never collapse a dog park onto a
 * bathing spot, or vice versa.
 */
export function withDoubleMappingCollapse(inner: PlaceProvider): PlaceProvider {
  return {
    // Called through rather than passed by reference: an unbound method
    // loses the provider it belongs to.
    findDogParks: async (lat, lon, radiusM) =>
      collapseDoubleMapped(await inner.findDogParks(lat, lon, radiusM)),
    findBathingSpots: async (lat, lon, radiusM) =>
      collapseDoubleMapped(await inner.findBathingSpots(lat, lon, radiusM)),
  };
}
