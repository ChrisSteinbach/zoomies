import {
  asBathingSpot,
  asDogPark,
  isBathingCandidate,
  isDogPark,
  toSpotTags,
} from "./osm-tags";

/**
 * The predicates exist for the offline dataset converter, which must decide
 * membership itself — the live path delegates that decision to Overpass by
 * encoding the same rules as a query. These tests pin the rules down so both
 * spellings keep giving one answer.
 */

describe("what counts as a dog park", () => {
  it("accepts the one tag that makes a dog park", () => {
    expect(isDogPark({ leisure: "dog_park", name: "Rålambshovsparken" })).toBe(
      true,
    );
  });

  it("rejects an ordinary park, whatever it is called", () => {
    expect(isDogPark({ leisure: "park", name: "Hundparken" })).toBe(false);
  });
});

describe("what counts as a bathing candidate", () => {
  it("accepts a bathing place that allows dogs", () => {
    expect(isBathingCandidate({ leisure: "bathing_place", dog: "yes" })).toBe(
      true,
    );
  });

  it("accepts a beach designated for dogs", () => {
    expect(isBathingCandidate({ natural: "beach", dog: "designated" })).toBe(
      true,
    );
  });

  it("accepts a swimming area that allows dogs", () => {
    expect(isBathingCandidate({ leisure: "swimming_area", dog: "yes" })).toBe(
      true,
    );
  });

  it("rejects a beach that says nothing about dogs", () => {
    // The commonest case in OSM, and the reason the layer is thin: absence
    // of a dog tag is not permission (docs/spec.md §4.3).
    expect(isBathingCandidate({ natural: "beach", name: "Långholmen" })).toBe(
      false,
    );
  });

  it("rejects a beach whose dog value is weaker than allowed", () => {
    // `dog=leashed` does not qualify a feature on its own — the live query's
    // tagged clauses require yes|designated, and the converter must agree.
    expect(isBathingCandidate({ natural: "beach", dog: "leashed" })).toBe(
      false,
    );
  });

  it("accepts a named hundbad with no dog tag at all", () => {
    // The Sweden-specific fallback (§4.3): the word in the name is the only
    // evidence, and provenance will say so.
    expect(
      isBathingCandidate({ natural: "water", name: "Ängsjö Hundbad" }),
    ).toBe(true);
  });

  it("matches the name without caring about case", () => {
    // The live query's regex carries the `i` flag; the predicate must too.
    expect(isBathingCandidate({ leisure: "park", name: "HUNDBADET" })).toBe(
      true,
    );
  });

  it("rejects a hundbad name outside the named-feature families", () => {
    // The same bound the live query applies: without a feature-shaped tag
    // there is nothing to render or grade, so the name alone is not enough.
    expect(isBathingCandidate({ name: "Hundbadet", highway: "bus_stop" })).toBe(
      false,
    );
  });

  it("keeps a dog-banning hundbad as a candidate, for grading to drop", () => {
    // Candidacy and claim are separate questions, as they are live: the name
    // clause matches the feature, then its own tags deny dogs and the
    // translation drops it — a beach called Hundbadet that bans dogs must
    // never become a pin (§3).
    const tags = { natural: "beach", name: "Hundbadet", dog: "no" };

    expect(isBathingCandidate(tags)).toBe(true);
    expect(
      asBathingSpot(
        { id: "way/1", name: "Hundbadet", lat: 59.3, lon: 18.1, tags: {} },
        tags,
      ),
    ).toBeUndefined();
  });
});

/**
 * `toSpotTags` is the display-tag half of the translation: it decides what a
 * user sees about fencing, lighting and ground surface. Both `overpass.ts`
 * and the offline converter feed raw OSM tags through this one function, so
 * the matrix belongs here rather than in either caller's tests.
 */
describe("translating OSM tags into display tags", () => {
  it("says fenced when the feature is tagged fenced=yes", () => {
    expect(toSpotTags({ fenced: "yes" }).fenced).toBe(true);
  });

  it("says not fenced when the feature is tagged fenced=no", () => {
    expect(toSpotTags({ fenced: "no" }).fenced).toBe(false);
  });

  it("says fenced when the outline is tagged barrier=fence", () => {
    expect(toSpotTags({ barrier: "fence" }).fenced).toBe(true);
  });

  it("says not fenced when the outline is tagged barrier=no", () => {
    expect(toSpotTags({ barrier: "no" }).fenced).toBe(false);
  });

  it("prefers fenced over barrier when both are tagged", () => {
    // fenced is the direct statement about the park; barrier is about one of
    // its edges, so fenced wins where the two disagree.
    expect(toSpotTags({ fenced: "yes", barrier: "no" }).fenced).toBe(true);
  });

  it("says nothing about fencing when neither tag makes a claim", () => {
    // A bare fence_type is not a claim that the park is enclosed.
    expect(toSpotTags({ fence_type: "chain_link" }).fenced).toBeUndefined();
  });

  it("says lit when the feature is tagged lit=yes", () => {
    expect(toSpotTags({ lit: "yes" }).lit).toBe(true);
  });

  it("says lit for a lighting schedule, which still means there are lamps", () => {
    expect(toSpotTags({ lit: "sunset-sunrise" }).lit).toBe(true);
  });

  it("says not lit only when the feature is tagged lit=no", () => {
    expect(toSpotTags({ lit: "no" }).lit).toBe(false);
  });

  it("says nothing about lighting when OSM does not", () => {
    expect(toSpotTags({}).lit).toBeUndefined();
  });

  it("passes surface through verbatim", () => {
    // Free-form by design (docs/spec.md): an enum here would silently drop
    // surface values nobody has thought of yet.
    expect(toSpotTags({ surface: "fine_gravel" }).surface).toBe("fine_gravel");
  });

  it("says nothing at all about an untagged feature", () => {
    expect(toSpotTags({ leisure: "dog_park" })).toEqual({});
  });
});

describe("asDogPark", () => {
  it("claims the feature as a dog park, unconditionally designated", () => {
    const spot = asDogPark({ id: "node/1", lat: 59.3, lon: 18.1, tags: {} });

    expect(spot.kind).toBe("dog_park");
    expect(spot.provenance).toBe("designated");
  });

  it("never adds a seasonal rule, since a dog park isn't seasonally closed", () => {
    // asDogPark has no tags to read a dog:conditional off in the first
    // place — this pins that the dog-park claim can never grow one.
    const spot = asDogPark({ id: "node/1", lat: 59.3, lon: 18.1, tags: {} });

    expect(spot.seasonal).toBeUndefined();
  });
});

describe("asBathingSpot: grading the claim", () => {
  const skeleton = { id: "way/1", lat: 59.3, lon: 18.1, tags: {} };

  it("grades a dog-designated feature as designated", () => {
    const spot = asBathingSpot(skeleton, { dog: "designated" });

    expect(spot?.provenance).toBe("designated");
  });

  it("grades dog=yes as permitted rather than designated", () => {
    const spot = asBathingSpot(skeleton, { dog: "yes" });

    expect(spot?.provenance).toBe("permitted");
  });

  it("grades dog=leashed as permitted", () => {
    // `leashed` can only arrive through the name fallback — the tagged
    // clauses require yes|designated — but it still says dogs belong here.
    const spot = asBathingSpot(skeleton, { dog: "leashed" });

    expect(spot?.provenance).toBe("permitted");
  });

  it("grades dog=unleashed as permitted too", () => {
    const spot = asBathingSpot(skeleton, { dog: "unleashed" });

    expect(spot?.provenance).toBe("permitted");
  });

  it("drops a feature whose tags say dogs are banned", () => {
    // A beach called Hundbadet that bans dogs must never become a pin (§3).
    const spot = asBathingSpot(skeleton, { dog: "no" });

    expect(spot).toBeUndefined();
  });

  it("grades an untagged feature as a name match", () => {
    // No dog tag at all: only the name-fallback candidacy check got it here.
    const spot = asBathingSpot(skeleton, {});

    expect(spot?.provenance).toBe("name-match");
  });
});

describe("asBathingSpot: the seasonal rule", () => {
  const skeleton = { id: "way/1", lat: 59.3, lon: 18.1, tags: {} };

  it("omits the seasonal field when there is no dog:conditional tag", () => {
    const spot = asBathingSpot(skeleton, { dog: "designated" });

    expect(spot?.seasonal).toBeUndefined();
  });

  it("attaches the parsed rule when dog:conditional is present", () => {
    const spot = asBathingSpot(skeleton, {
      dog: "yes",
      "dog:conditional": "no @ (Jun 1-Aug 31)",
    });

    expect(spot?.seasonal).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("keeps a rule it cannot read rather than dropping it", () => {
    // Something about dogs here is conditional; silently omitting the field
    // would read as "no restriction", a claim OSM never made.
    const spot = asBathingSpot(skeleton, {
      dog: "yes",
      "dog:conditional": "no @ (Su 10:00-18:00)",
    });

    expect(spot?.seasonal).toEqual({ kind: "unparsed" });
  });
});
