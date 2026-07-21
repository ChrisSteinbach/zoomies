import {
  BATHING_TARGET_RESULT_COUNT,
  SEARCH_RADII_M,
  TARGET_RESULT_COUNT,
  createExpandingSearch,
} from "./expanding-search";
import type { SpotFetch } from "./expanding-search";
import { PlaceProviderError } from "./place-provider";
import type { DogSpot } from "./types";

/** `count` plausible dog parks, which is all these tests care about. */
function someSpots(count: number): DogSpot[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `node/${index + 1}`,
    kind: "dog_park" as const,
    lat: 59.32 + index / 1_000,
    lon: 18.06 + index / 1_000,
    tags: {},
    provenance: "designated" as const,
  }));
}

/**
 * A lookup that answers each radius with however many spots the test says,
 * and records what it was asked.
 */
function lookupAnswering(byRadius: Record<number, DogSpot[]>): {
  fetch: SpotFetch;
  radiiAsked: number[];
} {
  const radiiAsked: number[] = [];
  return {
    radiiAsked,
    fetch: (_lat, _lon, radiusM) => {
      radiiAsked.push(radiusM);
      return Promise.resolve(byRadius[radiusM] ?? []);
    },
  };
}

describe("searching outwards until there is enough", () => {
  it("asks once when the nearest radius already has enough", async () => {
    // Central Stockholm: the 3 km pass alone returns about 31 parks.
    const overpass = lookupAnswering({ 3_000: someSpots(31) });

    const found = await createExpandingSearch(overpass.fetch)(59.3293, 18.0686);

    expect(overpass.radiiAsked).toEqual([3_000]);
    expect(found.radiusM).toBe(3_000);
    expect(found.spots).toHaveLength(31);
  });

  it("stops on exactly the target rather than looking further for luck", async () => {
    const overpass = lookupAnswering({
      3_000: someSpots(TARGET_RESULT_COUNT),
    });

    await createExpandingSearch(overpass.fetch)(59.3293, 18.0686);

    expect(overpass.radiiAsked).toEqual([3_000]);
  });

  it("widens the search where the map is thin", async () => {
    const overpass = lookupAnswering({
      3_000: someSpots(2),
      10_000: someSpots(6),
    });

    const found = await createExpandingSearch(overpass.fetch)(59.8586, 17.6389);

    expect(overpass.radiiAsked).toEqual([3_000, 10_000]);
    expect(found.radiusM).toBe(10_000);
    expect(found.spots).toHaveLength(6);
  });

  it("keeps what the wider radius found, not what the narrower one did", async () => {
    const near = someSpots(2);
    const wide = someSpots(6);
    const overpass = lookupAnswering({ 3_000: near, 10_000: wide });

    const found = await createExpandingSearch(overpass.fetch)(59.8586, 17.6389);

    expect(found.spots).toEqual(wide);
  });

  it("gives up after the widest radius, reporting how far it looked", async () => {
    const overpass = lookupAnswering({});

    const found = await createExpandingSearch(overpass.fetch)(
      -3.4653,
      -62.2159,
    );

    expect(overpass.radiiAsked).toEqual([...SEARCH_RADII_M]);
    // Nothing anywhere is an answer the UI must be able to phrase precisely:
    // "nothing within 25 km", not just "nothing".
    expect(found.spots).toEqual([]);
    expect(found.radiusM).toBe(25_000);
  });

  it("returns the little it found rather than nothing at all", async () => {
    const lonely = someSpots(1);
    const overpass = lookupAnswering({
      3_000: lonely,
      10_000: lonely,
      25_000: lonely,
    });

    const found = await createExpandingSearch(overpass.fetch)(64.75, 20.95);

    expect(found.spots).toEqual(lonely);
    expect(found.radiusM).toBe(25_000);
  });

  it("lets a failure through instead of widening the search after one", async () => {
    let calls = 0;
    const fetch: SpotFetch = () => {
      calls++;
      return Promise.reject(
        new PlaceProviderError("timeout", "Overpass took too long"),
      );
    };

    await expect(
      createExpandingSearch(fetch)(59.3293, 18.0686),
    ).rejects.toBeInstanceOf(PlaceProviderError);
    // A bigger version of the question a struggling service just failed is
    // not a recovery strategy.
    expect(calls).toBe(1);
  });
});

describe("a layer that settles for less", () => {
  it("stops widening once its own lower target is met", async () => {
    // Three bathing spots would leave the parks search widening to 25 km;
    // for a layer this thinly mapped it is already a choice worth showing.
    const overpass = lookupAnswering({
      3_000: someSpots(BATHING_TARGET_RESULT_COUNT),
    });

    await createExpandingSearch(overpass.fetch, {
      targetCount: BATHING_TARGET_RESULT_COUNT,
    })(59.3293, 18.0686);

    expect(overpass.radiiAsked).toEqual([3_000]);
  });

  it("still widens when even the lower target is not met", async () => {
    const overpass = lookupAnswering({
      3_000: someSpots(BATHING_TARGET_RESULT_COUNT - 1),
      10_000: someSpots(BATHING_TARGET_RESULT_COUNT),
    });

    await createExpandingSearch(overpass.fetch, {
      targetCount: BATHING_TARGET_RESULT_COUNT,
    })(59.3293, 18.0686);

    expect(overpass.radiiAsked).toEqual([3_000, 10_000]);
  });
});
