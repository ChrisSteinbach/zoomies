import {
  collapseDoubleMapped,
  withDoubleMappingCollapse,
} from "./double-mapping";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

/**
 * The real double-mapped pair that prompted zoomies-hrm (verbatim from the
 * published dataset, 2026-07-23): a POI node and the park's own outline,
 * ~12.4 m apart, both `leisure=dog_park`.
 */
const MONTELIUS_NODE: DogSpot = {
  id: "node/13245355311",
  name: "Monteliusvägens hundrastgård",
  lat: 59.3207873,
  lon: 18.0596507,
  tags: { fenced: true },
  kind: "dog_park",
  provenance: "designated",
};
const MONTELIUS_AREA: DogSpot = {
  id: "way/1443425101",
  name: "Monteliusvägens hundrastgård",
  lat: 59.320803,
  lon: 18.0594636,
  tags: { fenced: true },
  kind: "dog_park",
  provenance: "designated",
};

/**
 * Two genuine sections of one real facility (verbatim, 2026-07-23), both
 * areas, same name, ~134 m apart. The rule must never collapse these: two
 * areas the same distance apart, or closer, are plausibly two honest
 * sections rather than one double-mapped park.
 */
const DOG_PARK_SECTION_A: DogSpot = {
  id: "way/1133889168",
  name: "Dog Park",
  lat: 39.8441551,
  lon: -82.8505119,
  tags: { fenced: true },
  kind: "dog_park",
  provenance: "designated",
};
const DOG_PARK_SECTION_B: DogSpot = {
  id: "way/1133889174",
  name: "Dog Park",
  lat: 39.8429541,
  lon: -82.8504432,
  tags: { fenced: true },
  kind: "dog_park",
  provenance: "designated",
};

describe("collapseDoubleMapped", () => {
  it("collapses the real Monteliusvägen pair into one spot, keeping the way's own id and position", () => {
    const result = collapseDoubleMapped([MONTELIUS_NODE, MONTELIUS_AREA]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("way/1443425101");
    expect(result[0]?.lat).toBe(59.320803);
    expect(result[0]?.lon).toBe(18.0594636);
  });

  it("leaves a node beyond 50 m of a same-name, same-kind area as two results", () => {
    const area: DogSpot = {
      id: "way/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    // 0.001° of latitude ≈ 111 m north — comfortably beyond the 50 m
    // collapse distance, unlike the ~12 m Monteliusvägen pair above.
    const node: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.301,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(2);
  });

  it("leaves a node within 50 m as two results when its name differs from the area's", () => {
    const area: DogSpot = {
      id: "way/1",
      name: "Rålambshovsparkens hundrastgård",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    // ~33 m south — well inside 50 m, so only the name mismatch is on trial.
    const node: DogSpot = {
      id: "node/1",
      name: "Vasaparkens hundrastgård",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(2);
  });

  it("collapses when the two names agree only case-insensitively", () => {
    const area: DogSpot = {
      id: "way/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const node: DogSpot = {
      id: "node/1",
      name: "dog park",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("way/1");
  });

  it("collapses an unnamed node within 50 m of a named area", () => {
    const area: DogSpot = {
      id: "way/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const node: DogSpot = {
      id: "node/1",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Dog Park");
  });

  it("collapses a named node onto an unnamed area, and the kept row carries the node's name", () => {
    const area: DogSpot = {
      id: "way/1",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const node: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("way/1");
    expect(result[0]?.name).toBe("Dog Park");
  });

  it("never collapses area vs area, even the same name close together", () => {
    // A synthetic pair well under 50 m apart, to prove it's the
    // area-vs-area rule at work and not just the 134 m real pair's distance
    // saving it.
    const closeSectionA: DogSpot = {
      id: "way/100",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const closeSectionB: DogSpot = {
      id: "way/101",
      name: "Dog Park",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([
      DOG_PARK_SECTION_A,
      DOG_PARK_SECTION_B,
      closeSectionA,
      closeSectionB,
    ]);

    expect(result).toHaveLength(4);
    expect(result.map((spot) => spot.id).sort()).toEqual(
      ["way/1133889168", "way/1133889174", "way/100", "way/101"].sort(),
    );
  });

  it("never collapses node vs node, even the same name close together", () => {
    const nodeA: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const nodeB: DogSpot = {
      id: "node/2",
      name: "Dog Park",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([nodeA, nodeB]);

    expect(result).toHaveLength(2);
  });

  it("does not collapse a dog_park node onto a bathing_spot area at the same position", () => {
    const node: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const area: DogSpot = {
      id: "way/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "bathing_spot",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(2);
  });

  it("treats a relation id as an area, and collapses a node onto it", () => {
    const area: DogSpot = {
      id: "relation/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const node: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("relation/1");
  });

  it("adopts a tag the area is silent on, and keeps the area's surveyed claim over the node's", () => {
    const area: DogSpot = {
      id: "way/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      // Surveyed: this park is not fenced. Says nothing about lighting.
      tags: { fenced: false },
      kind: "dog_park",
      provenance: "designated",
    };
    const node: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.2997,
      lon: 18.1,
      tags: { fenced: true, lit: true },
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(1);
    // Adopted: the area said nothing about lighting.
    expect(result[0]?.tags.lit).toBe(true);
    // Preserved: the area's surveyed "not fenced" beats the node's "fenced".
    expect(result[0]?.tags.fenced).toBe(false);
  });

  it("adopts a seasonal rule from the dropped node when the area is silent", () => {
    const area: DogSpot = {
      id: "way/1",
      name: "Hundbadet",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "bathing_spot",
      provenance: "designated",
    };
    const node: DogSpot = {
      id: "node/1",
      name: "Hundbadet",
      lat: 59.2997,
      lon: 18.1,
      tags: {},
      kind: "bathing_spot",
      provenance: "designated",
      seasonal: { kind: "unparsed" },
    };

    const result = collapseDoubleMapped([node, area]);

    expect(result).toHaveLength(1);
    expect(result[0]?.seasonal).toEqual({ kind: "unparsed" });
  });

  it("collapses a node onto the nearest of two candidate areas, and only that one adopts", () => {
    const node: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.3,
      lon: 18.1,
      tags: { lit: true },
      kind: "dog_park",
      provenance: "designated",
    };
    // ~15.6 m from the node — the nearer of the two candidates.
    const nearArea: DogSpot = {
      id: "way/1",
      lat: 59.30014,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    // ~35.6 m from the node — still within 50 m, but farther than nearArea.
    const farArea: DogSpot = {
      id: "way/2",
      lat: 59.30032,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([node, nearArea, farArea]);

    expect(result).toHaveLength(2);
    const kept = result.find((spot) => spot.id === "way/1");
    const untouched = result.find((spot) => spot.id === "way/2");
    expect(kept?.name).toBe("Dog Park");
    expect(kept?.tags.lit).toBe(true);
    expect(untouched?.name).toBeUndefined();
    expect(untouched?.tags).toEqual({});
  });

  it("produces the same result regardless of input order", () => {
    const untouched: DogSpot = {
      id: "way/999",
      name: "Rålambshovsparkens hundrastgård",
      lat: 59.33,
      lon: 18.03,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };

    const forward = collapseDoubleMapped([
      MONTELIUS_NODE,
      MONTELIUS_AREA,
      untouched,
    ]);
    const reversed = collapseDoubleMapped([
      untouched,
      MONTELIUS_AREA,
      MONTELIUS_NODE,
    ]);

    expect(reversed).toEqual(forward);
  });

  it("keeps a same-id twin of another kind untouched when a node collapses onto one of them", () => {
    // The dataset stores a place that is both a dog park and a named hundbad
    // once per kind, same id. A park node collapsing onto the park twin must
    // not smuggle its adoptions onto the bathing twin.
    const parkArea: DogSpot = {
      id: "way/1",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "dog_park",
      provenance: "designated",
    };
    const bathingTwin: DogSpot = {
      id: "way/1",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "bathing_spot",
      provenance: "name-match",
    };
    const parkNode: DogSpot = {
      id: "node/1",
      name: "Hundbadet",
      lat: 59.2997,
      lon: 18.1,
      tags: { lit: true },
      kind: "dog_park",
      provenance: "designated",
    };

    const result = collapseDoubleMapped([parkNode, parkArea, bathingTwin]);

    expect(result).toHaveLength(2);
    const park = result.find((spot) => spot.kind === "dog_park");
    const bathing = result.find((spot) => spot.kind === "bathing_spot");
    expect(park?.name).toBe("Hundbadet");
    expect(park?.tags.lit).toBe(true);
    expect(bathing?.name).toBeUndefined();
    expect(bathing?.tags).toEqual({});
  });

  it("never mutates the original area object, even when a collapse adopts a tag and a name", () => {
    const area: DogSpot = {
      id: "way/1",
      lat: 59.3,
      lon: 18.1,
      tags: { fenced: false },
      kind: "dog_park",
      provenance: "designated",
    };
    const areaBeforeCollapse = structuredClone(area);
    const node: DogSpot = {
      id: "node/1",
      name: "Dog Park",
      lat: 59.2997,
      lon: 18.1,
      tags: { fenced: true, lit: true },
      kind: "dog_park",
      provenance: "designated",
    };

    collapseDoubleMapped([node, area]);

    expect(area).toEqual(areaBeforeCollapse);
  });
});

describe("withDoubleMappingCollapse", () => {
  it("collapses double-mapped results from the wrapped provider, for both dog parks and bathing spots", async () => {
    const bathingNode: DogSpot = {
      id: "node/1",
      name: "Hundbadet",
      lat: 59.3,
      lon: 18.1,
      tags: {},
      kind: "bathing_spot",
      provenance: "designated",
    };
    // ~11 m away — well inside the collapse distance.
    const bathingArea: DogSpot = {
      id: "way/2",
      name: "Hundbadet",
      lat: 59.3001,
      lon: 18.1,
      tags: {},
      kind: "bathing_spot",
      provenance: "designated",
    };
    const inner: PlaceProvider = {
      findDogParks: async () => [MONTELIUS_NODE, MONTELIUS_AREA],
      findBathingSpots: async () => [bathingNode, bathingArea],
    };

    const provider = withDoubleMappingCollapse(inner);
    const parks = await provider.findDogParks(59.32, 18.06, 5000);
    const bathing = await provider.findBathingSpots(59.3, 18.1, 5000);

    expect(parks).toHaveLength(1);
    expect(parks[0]?.id).toBe("way/1443425101");
    expect(bathing).toHaveLength(1);
    expect(bathing[0]?.id).toBe("way/2");
  });
});
