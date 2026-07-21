import { CURRENT_KEY_PREFIXES } from "./idb";
import { CACHE_TTL_MS, withCache } from "./place-cache";
import type { CacheStore } from "./place-cache";
import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

/** One plausible dog park. The tests care only that it survives a round trip. */
function dogSpot(id: string): DogSpot {
  return {
    id,
    kind: "dog_park",
    name: "Rålambshovsparkens hundrastgård",
    lat: 59.3283,
    lon: 18.0233,
    tags: { fenced: true, surface: "grass" },
    provenance: "designated",
  };
}

/** An in-memory {@link CacheStore}, standing in for IndexedDB. */
function fakeStore(): CacheStore & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: (key) => Promise.resolve(entries.get(key)),
    set: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
  };
}

/** One plausible hundbad, for the lookups that ask about bathing. */
function bathingSpot(id: string): DogSpot {
  return {
    id,
    kind: "bathing_spot",
    name: "Kärsön hundbad",
    lat: 59.3106,
    lon: 17.9187,
    tags: { surface: "sand" },
    provenance: "name-match",
  };
}

/** A provider that answers every lookup the same way, and counts the asking. */
function providerReturning(spots: DogSpot[]): PlaceProvider & {
  calls: () => number;
} {
  let calls = 0;
  const answer = () => {
    calls++;
    return Promise.resolve(spots);
  };
  return { calls: () => calls, findDogParks: answer, findBathingSpots: answer };
}

describe("reusing an answer", () => {
  it("asks once for two lookups from the same spot", async () => {
    const provider = providerReturning([dogSpot("way/58082448")]);
    const cached = withCache(provider, { store: fakeStore() });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    const second = await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(provider.calls()).toBe(1);
    expect(second).toEqual([dogSpot("way/58082448")]);
  });

  it("absorbs the GPS drifting a few dozen metres while the user stands still", async () => {
    const provider = providerReturning([dogSpot("way/58082448")]);
    const cached = withCache(provider, { store: fakeStore() });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    // ~50 m away: a phone reporting a new fix from the same bench.
    await cached.findDogParks(59.3294, 18.0692, 3_000);

    expect(provider.calls()).toBe(1);
  });

  it("asks again once the user has actually moved", async () => {
    const provider = providerReturning([dogSpot("way/58082448")]);
    const cached = withCache(provider, { store: fakeStore() });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    // ~670 m north, far enough to change which park is nearest.
    await cached.findDogParks(59.335, 18.0688, 3_000);

    expect(provider.calls()).toBe(2);
  });

  it("does not answer a wider search with a narrower search's results", async () => {
    const provider = providerReturning([dogSpot("way/58082448")]);
    const cached = withCache(provider, { store: fakeStore() });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    await cached.findDogParks(59.329, 18.0688, 10_000);

    // The expanding search asks about one centre at three radii; a 3 km
    // answer to a 25 km question would hide most of the map.
    expect(provider.calls()).toBe(2);
  });

  it("remembers that there is nothing here, so a bare region is asked about once", async () => {
    const provider = providerReturning([]);
    const cached = withCache(provider, { store: fakeStore() });

    const first = await cached.findDogParks(-3.4653, -62.2159, 25_000);
    const second = await cached.findDogParks(-3.4653, -62.2159, 25_000);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(provider.calls()).toBe(1);
  });

  it("stores both layers' answers under keys the schema cleanup recognises", async () => {
    const store = fakeStore();
    const cached = withCache(providerReturning([dogSpot("node/1")]), { store });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    await cached.findBathingSpots(59.329, 18.0688, 3_000);

    // A key outside the current prefixes would be swept away on next launch.
    const keys = [...store.entries.keys()];
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(CURRENT_KEY_PREFIXES.some((p) => key.startsWith(p))).toBe(true);
    }
  });
});

describe("keeping the two layers apart", () => {
  it("does not answer a bathing lookup with the parks found in that cell", async () => {
    const provider: PlaceProvider = {
      findDogParks: () => Promise.resolve([dogSpot("way/58082448")]),
      findBathingSpots: () => Promise.resolve([bathingSpot("way/4711")]),
    };
    const cached = withCache(provider, { store: fakeStore() });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    const bathing = await cached.findBathingSpots(59.329, 18.0688, 3_000);

    // Same cell, same radius, different question — and "nothing here" is the
    // answer most likely to be wrongly reused.
    expect(bathing).toEqual([bathingSpot("way/4711")]);
  });

  it("asks once for two bathing lookups from the same spot", async () => {
    const provider = providerReturning([bathingSpot("way/4711")]);
    const cached = withCache(provider, { store: fakeStore() });

    await cached.findBathingSpots(59.329, 18.0688, 3_000);
    const second = await cached.findBathingSpots(59.329, 18.0688, 3_000);

    expect(provider.calls()).toBe(1);
    expect(second).toEqual([bathingSpot("way/4711")]);
  });

  it("brings a seasonal ban back intact", async () => {
    const banned: DogSpot = {
      ...bathingSpot("way/4711"),
      // The Stockholm summer ban, as OSM writes it (docs/spec.md §4.5.3).
      seasonal: {
        kind: "ban",
        from: { month: 6, day: 1 },
        to: { month: 8, day: 31 },
      },
    };
    const provider = providerReturning([banned]);
    const cached = withCache(provider, { store: fakeStore() });

    await cached.findBathingSpots(59.329, 18.0688, 3_000);
    const second = await cached.findBathingSpots(59.329, 18.0688, 3_000);

    expect(second).toEqual([banned]);
    expect(provider.calls()).toBe(1);
  });

  it("treats a stored ban window it cannot read as nothing stored", async () => {
    const store = fakeStore();
    const provider = providerReturning([bathingSpot("way/4711")]);
    const cached = withCache(provider, { store });

    await cached.findBathingSpots(59.329, 18.0688, 3_000);
    for (const key of store.entries.keys()) {
      store.entries.set(key, {
        storedAt: Date.now(),
        spots: [
          {
            ...bathingSpot("way/4711"),
            seasonal: { kind: "ban", from: { month: 13, day: 1 }, to: "Aug" },
          },
        ],
      });
    }
    const spots = await cached.findBathingSpots(59.329, 18.0688, 3_000);

    // A half-read ban is worse than none: the UI would work out that today is
    // fine at a beach where a dog is illegal.
    expect(spots).toEqual([bathingSpot("way/4711")]);
    expect(provider.calls()).toBe(2);
  });
});

describe("when a cached answer cannot be trusted", () => {
  it("asks again once the answer is a week old", async () => {
    const provider = providerReturning([dogSpot("node/1")]);
    let clock = Date.parse("2026-07-21T09:00:00Z");
    const cached = withCache(provider, {
      store: fakeStore(),
      now: () => clock,
    });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    clock += CACHE_TTL_MS;
    await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(provider.calls()).toBe(2);
  });

  it("still reuses an answer that has not quite expired", async () => {
    const provider = providerReturning([dogSpot("node/1")]);
    let clock = Date.parse("2026-07-21T09:00:00Z");
    const cached = withCache(provider, {
      store: fakeStore(),
      now: () => clock,
    });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    clock += CACHE_TTL_MS - 1;
    await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(provider.calls()).toBe(1);
  });

  it("distrusts an answer stored in the future by a clock that has since been corrected", async () => {
    const provider = providerReturning([dogSpot("node/1")]);
    let clock = Date.parse("2026-07-21T09:00:00Z");
    const cached = withCache(provider, {
      store: fakeStore(),
      now: () => clock,
    });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    clock -= 60 * 60 * 1_000;
    await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(provider.calls()).toBe(2);
  });

  it("treats a stored value it cannot make sense of as nothing stored", async () => {
    const store = fakeStore();
    const provider = providerReturning([dogSpot("node/1")]);
    const cached = withCache(provider, { store });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    for (const key of store.entries.keys()) {
      store.entries.set(key, { storedAt: "yesterday", spots: "several" });
    }
    const spots = await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(provider.calls()).toBe(2);
    expect(spots).toEqual([dogSpot("node/1")]);
  });

  it("throws away the whole entry when one spot in it is unusable", async () => {
    const store = fakeStore();
    const provider = providerReturning([dogSpot("node/1")]);
    const cached = withCache(provider, { store });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    for (const key of store.entries.keys()) {
      store.entries.set(key, {
        storedAt: Date.now(),
        // A spot with no position cannot go on a map; passing the rest off
        // as the whole answer would be worse than asking again.
        spots: [dogSpot("node/1"), { id: "node/2", kind: "dog_park" }],
      });
    }
    const spots = await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(spots).toEqual([dogSpot("node/1")]);
    expect(provider.calls()).toBe(2);
  });

  it("does not remember a failure", async () => {
    let calls = 0;
    const findDogParks = () => {
      calls++;
      if (calls === 1) {
        return Promise.reject(
          new PlaceProviderError("timeout", "Overpass took too long"),
        );
      }
      return Promise.resolve([dogSpot("node/1")]);
    };
    const provider: PlaceProvider = {
      findDogParks,
      findBathingSpots: findDogParks,
    };
    const cached = withCache(provider, { store: fakeStore() });

    await expect(
      cached.findDogParks(59.329, 18.0688, 3_000),
    ).rejects.toBeInstanceOf(PlaceProviderError);
    const spots = await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(spots).toEqual([dogSpot("node/1")]);
  });
});

describe("when storage is unavailable", () => {
  it("answers anyway when nothing can be read", async () => {
    const provider = providerReturning([dogSpot("node/1")]);
    const cached = withCache(provider, {
      // What private browsing, a locked profile or a Node process looks like.
      store: {
        get: () => Promise.reject(new DOMException("no access")),
        set: () => Promise.resolve(),
      },
    });

    const spots = await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(spots).toEqual([dogSpot("node/1")]);
  });

  it("answers anyway when nothing can be written", async () => {
    const provider = providerReturning([dogSpot("node/1")]);
    const cached = withCache(provider, {
      store: {
        get: () => Promise.resolve(undefined),
        set: () =>
          Promise.reject(
            new DOMException("Quota exceeded", "QuotaExceededError"),
          ),
      },
    });

    const spots = await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(spots).toEqual([dogSpot("node/1")]);
  });

  it("keeps working as a plain pass-through, lookup after lookup", async () => {
    const provider = providerReturning([dogSpot("node/1")]);
    const cached = withCache(provider, {
      store: {
        get: () => Promise.reject(new DOMException("no access")),
        set: () => Promise.reject(new DOMException("no access")),
      },
    });

    await cached.findDogParks(59.329, 18.0688, 3_000);
    await cached.findDogParks(59.329, 18.0688, 3_000);

    expect(provider.calls()).toBe(2);
  });
});
