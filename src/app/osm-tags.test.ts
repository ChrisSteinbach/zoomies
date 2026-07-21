import { asBathingSpot, isBathingCandidate, isDogPark } from "./osm-tags";

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
