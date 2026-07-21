import type { DogSpot } from "./types";

/**
 * Searching outwards until there is enough to show (docs/spec.md §7.2).
 *
 * Policy about *how far* to ask, layered on one lookup that does exactly one
 * query. It takes that lookup as a function rather than a whole provider,
 * because the policy is per layer: parks and bathing spots widen
 * independently, to different targets, over the same provider stack.
 *
 * The result is not a `PlaceProvider`'s, because it answers a richer question
 * than "what is within R metres" — it also reports how far it had to look.
 */

/**
 * How far to look, narrowest first, in metres.
 *
 * One 25 km query would be simpler, and worse: Overpass is a free shared
 * service (docs/spec.md §5), and in central Stockholm a 25 km radius returns
 * hundreds of parks to answer a question about the nearest handful. Starting
 * narrow keeps the common case to one cheap query and pays for reach only
 * where the map is thin.
 *
 * The tuning is an open question (docs/spec.md §9), so it lives here as one
 * named list rather than as numbers scattered through the callers.
 */
export const SEARCH_RADII_M: readonly number[] = [3_000, 10_000, 25_000];

/**
 * How many results count as enough to stop widening (docs/spec.md §7.2).
 *
 * A target, not a promise: a thinly mapped region genuinely has fewer, and
 * returning fewer beats returning confidently wrong ones (§3).
 */
export const TARGET_RESULT_COUNT = 5;

/**
 * The same, for bathing spots — lower, because the layer is thinner.
 *
 * Bathing data is best-effort by design (§4.3, §4.5.2): there is no single
 * primary tag, and the dog subtag is usually the one a mapper omits. Holding
 * that layer to the parks target of five would widen nearly every search to
 * 25 km — three queries against a free shared service — chasing results that
 * mostly are not mapped at all. Three is enough to choose between, honest
 * about a thin layer, and stops widening while the answers are still nearby.
 */
export const BATHING_TARGET_RESULT_COUNT = 3;

/** What a search found, and how far it had to look to find it. */
export interface ExpandingSearchResult {
  /**
   * What the widest radius queried returned, in no particular order —
   * sorting is the caller's job, because it depends on the user's live
   * position rather than the query centre.
   */
  spots: DogSpot[];
  /**
   * The widest radius actually queried, in metres.
   *
   * The UI has to be honest about a short answer, and "nothing within 3 km"
   * and "nothing within 25 km" are different statements. Without this the
   * only truthful thing it could say is "nothing", which understates a search
   * that covered a whole city region.
   */
  radiusM: number;
}

/** Spots of one layer near a position, looking further out until enough. */
export type ExpandingSearch = (
  lat: number,
  lon: number,
) => Promise<ExpandingSearchResult>;

/** One layer's lookup within a fixed radius: a provider method, unbound. */
export type SpotFetch = (
  lat: number,
  lon: number,
  radiusM: number,
) => Promise<DogSpot[]>;

export interface ExpandingSearchOptions {
  /** How many results are enough. Defaults to {@link TARGET_RESULT_COUNT}. */
  targetCount?: number;
}

/**
 * Wraps one lookup in the expanding-radius policy.
 *
 * Queries are deliberately sequential: each one exists only because the
 * previous answer was too thin, and firing them together would ask a shared
 * service three questions to use the answer to one.
 */
export function createExpandingSearch(
  fetch: SpotFetch,
  options: ExpandingSearchOptions = {},
): ExpandingSearch {
  const targetCount = options.targetCount ?? TARGET_RESULT_COUNT;

  return async (lat, lon) => {
    // Every radius is a superset of the one before it, so the last answer is
    // the fullest one — there is nothing to merge.
    let found: ExpandingSearchResult = {
      spots: [],
      radiusM: SEARCH_RADII_M[0],
    };

    for (const radiusM of SEARCH_RADII_M) {
      // A failure stops the search. Widening after one is asking a struggling
      // service a bigger version of the question it just failed to answer,
      // and reporting the wider result as if the narrow one had succeeded
      // would hide the failure the UI must show (§7.6).
      const spots = await fetch(lat, lon, radiusM);
      found = { spots, radiusM };
      if (spots.length >= targetCount) break;
    }

    // Zero results after the widest radius is a legitimate answer, not an
    // error (§3) — the UI says "nothing within 25 km" and means it.
    return found;
  };
}
