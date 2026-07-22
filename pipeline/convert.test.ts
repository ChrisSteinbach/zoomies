import { DATASET_SCHEMA_VERSION } from "../src/app/offline-dataset";
import type { Dataset } from "../src/app/offline-dataset";
import type { DogSpot } from "../src/app/types";
import {
  assertDatasetSane,
  buildDataset,
  convertFeatures,
  parsePoly,
} from "./convert";

/**
 * A .poly boundary in miniature: two include rings (the first with
 * E-notation coordinates, as Geofabrik writes them) and one "!" hole.
 * Sweden-shaped on purpose — lats 55–69, lons 10–24 are disjoint ranges,
 * so a lat/lon transposition cannot produce the values the tests expect.
 */
const SWEDEN_ISH_POLY = [
  "sweden-ish",
  "mainland",
  "   1.088E+01   5.53E+01",
  "   24.2   55.3",
  "   24.2   69.1",
  "   10.88   69.1",
  "END",
  "!vanern",
  "   12.3   58.4",
  "   13.9   58.4",
  "   13.1   59.3",
  "END",
  "gotland",
  "   18.1   57.2",
  "   19.0   57.2",
  "   18.5   57.9",
  "END",
  "END",
].join("\n");

describe("parsePoly", () => {
  it("separates include rings from ! holes", () => {
    const coverage = parsePoly(SWEDEN_ISH_POLY);

    expect(coverage.include).toHaveLength(2);
    expect(coverage.exclude).toHaveLength(1);
    expect(coverage.exclude[0]).toEqual([
      [58.4, 12.3],
      [58.4, 13.9],
      [59.3, 13.1],
    ]);
  });

  it("swaps .poly's lon-first pairs into the app's lat-first rings", () => {
    const coverage = parsePoly(SWEDEN_ISH_POLY);

    // Source lines are "18.1 57.2" etc — lon first. The ring must come out
    // lat first, and with these Sweden-shaped numbers a transposed parse
    // has no way to match.
    expect(coverage.include[1]).toEqual([
      [57.2, 18.1],
      [57.2, 19.0],
      [57.9, 18.5],
    ]);
  });

  it("reads E-notation coordinates", () => {
    const coverage = parsePoly(SWEDEN_ISH_POLY);

    // "1.088E+01   5.53E+01" — lon 10.88, lat 55.3.
    expect(coverage.include[0][0]).toEqual([55.3, 10.88]);
  });

  it("throws on a section never closed by END", () => {
    const truncated = ["name", "ring", "   12.0   57.0"].join("\n");

    expect(() => parsePoly(truncated)).toThrow(/never closed/);
  });

  it("throws when the file's final END is missing", () => {
    const unclosed = ["name", "ring", "   12.0   57.0", "END"].join("\n");

    expect(() => parsePoly(unclosed)).toThrow(/final END/);
  });

  it("throws on a coordinate line that is not two numbers", () => {
    const garbled = ["name", "ring", "here be dragons", "END", "END"].join(
      "\n",
    );

    expect(() => parsePoly(garbled)).toThrow(/not a "lon lat"/);
  });
});

describe("convertFeatures", () => {
  it("translates a Point dog park with its display tags", () => {
    const feature = {
      type: "Feature",
      id: "n4711",
      properties: {
        leisure: "dog_park",
        name: "Vasaparkens hundrastgård",
        fenced: "yes",
        lit: "yes",
        surface: "grass",
      },
      geometry: { type: "Point", coordinates: [18.0432101, 59.3412345] },
    };

    expect(convertFeatures([feature])).toEqual([
      {
        id: "node/4711",
        kind: "dog_park",
        name: "Vasaparkens hundrastgård",
        lat: 59.3412345,
        lon: 18.0432101,
        tags: { fenced: true, lit: true, surface: "grass" },
        provenance: "designated",
      },
    ]);
  });

  it("decodes an assembled area back to the closed way it came from", () => {
    // osmium assembles a closed way carrying `area=yes` into a synthetic
    // area object numbered 2×way-id. The real case that caught this:
    // Vanadislundens hundrastgård, way 703298765, exported as a1406597530 —
    // and silently dropped until the decoder learnt the scheme.
    const feature = {
      type: "Feature",
      id: "a1406597530",
      properties: {
        leisure: "dog_park",
        area: "yes",
        name: "Category:Vanadislundens hundrastgård",
      },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [18.055, 59.347],
              [18.057, 59.347],
              [18.057, 59.349],
              [18.055, 59.349],
              [18.055, 59.347],
            ],
          ],
        ],
      },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.id).toBe("way/703298765");
    expect(spot.kind).toBe("dog_park");
  });

  it("decodes an odd-numbered area back to its multipolygon relation", () => {
    // Areas built from relations are numbered 2×relation-id+1: a247 is
    // relation 123. Without the decoding, every relation-mapped park
    // vanishes from the dataset while the live path keeps returning it.
    const feature = {
      type: "Feature",
      id: "a247",
      properties: { leisure: "dog_park" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [18.0, 59.3],
              [18.01, 59.3],
              [18.01, 59.31],
              [18.0, 59.31],
              [18.0, 59.3],
            ],
          ],
        ],
      },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.id).toBe("relation/123");
  });

  it("keeps one spot when a closed way arrives as both its spellings", () => {
    // Belt and braces around osmium's export config: if the same closed way
    // ever surfaces both as its linestring ("w9") and as the area assembled
    // from it ("a18"), both spell the same ring — one spot, not two.
    const ring = [
      [18.0, 59.3],
      [18.01, 59.3],
      [18.01, 59.31],
      [18.0, 59.31],
      [18.0, 59.3],
    ];
    const asLine = {
      type: "Feature",
      id: "w9",
      properties: { leisure: "dog_park", name: "Tvillingparken" },
      geometry: { type: "LineString", coordinates: ring },
    };
    const asArea = {
      type: "Feature",
      id: "a18",
      properties: { leisure: "dog_park", name: "Tvillingparken" },
      geometry: { type: "Polygon", coordinates: [ring] },
    };

    const spots = convertFeatures([asLine, asArea]);
    expect(spots.map((spot) => spot.id)).toEqual(["way/9"]);
  });

  it("places an area park at the center of its bounding box", () => {
    // An L-shape whose bounding box spans lon 18.0–18.02, lat 59.3–59.31 —
    // center (lat 59.305, lon 18.01). The average of the vertices lies
    // elsewhere, so this fails for a centroid implementation: bbox center
    // is what Overpass `out center;` returns, and the two data paths must
    // place the same park in the same place.
    const feature = {
      type: "Feature",
      id: "w58082448",
      properties: { leisure: "dog_park" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [18.0, 59.3],
            [18.02, 59.3],
            [18.02, 59.302],
            [18.004, 59.302],
            [18.004, 59.31],
            [18.0, 59.31],
            [18.0, 59.3],
          ],
        ],
      },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.id).toBe("way/58082448");
    expect(spot.lat).toBe(59.305);
    expect(spot.lon).toBe(18.01);
  });

  it("spans a MultiPolygon's bounding box across all its parts", () => {
    // Two separated squares: lon 17.9–18.1, lat 59.3–59.35 → the center
    // (59.325, 18) sits in the water between them, exactly as the live
    // path's `out center;` would put it.
    const feature = {
      type: "Feature",
      id: "r13",
      properties: { leisure: "dog_park" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [17.9, 59.3],
              [17.92, 59.3],
              [17.92, 59.31],
              [17.9, 59.31],
              [17.9, 59.3],
            ],
          ],
          [
            [
              [18.08, 59.34],
              [18.1, 59.34],
              [18.1, 59.35],
              [18.08, 59.35],
              [18.08, 59.34],
            ],
          ],
        ],
      },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.id).toBe("relation/13");
    expect(spot.lat).toBe(59.325);
    expect(spot.lon).toBe(18);
  });

  it("pools a GeometryCollection's members into one bounding box", () => {
    // Point plus LineString: lon 18.0–18.1, lat 59.3–59.35 → (59.325, 18.05).
    const feature = {
      type: "Feature",
      id: "r14",
      properties: { leisure: "dog_park" },
      geometry: {
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [18.0, 59.3] },
          {
            type: "LineString",
            coordinates: [
              [18.1, 59.32],
              [18.06, 59.35],
            ],
          },
        ],
      },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.lat).toBe(59.325);
    expect(spot.lon).toBe(18.05);
  });

  it("emits a hundbad-named dog park into both layers", () => {
    // A real element (node 8693130278): a dog park named "Hundbadplats …"
    // is genuinely both, and each of the two live queries would return it.
    // The offline path must say the same; visibility dedup is downstream.
    const feature = {
      type: "Feature",
      id: "n8693130278",
      properties: { leisure: "dog_park", name: "Hundbadplats Rönningesjön" },
      geometry: { type: "Point", coordinates: [18.1112, 59.5077] },
    };

    expect(convertFeatures([feature])).toEqual([
      {
        id: "node/8693130278",
        kind: "bathing_spot",
        name: "Hundbadplats Rönningesjön",
        lat: 59.5077,
        lon: 18.1112,
        tags: {},
        provenance: "name-match",
      },
      {
        id: "node/8693130278",
        kind: "dog_park",
        name: "Hundbadplats Rönningesjön",
        lat: 59.5077,
        lon: 18.1112,
        tags: {},
        provenance: "designated",
      },
    ]);
  });

  it("grades a beach that allows dogs as permitted", () => {
    const feature = {
      type: "Feature",
      id: "w2001",
      properties: { natural: "beach", dog: "yes" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [17.5, 59.0],
            [17.502, 59.0],
            [17.502, 59.001],
            [17.5, 59.001],
            [17.5, 59.0],
          ],
        ],
      },
    };

    expect(convertFeatures([feature])).toEqual([
      {
        id: "way/2001",
        kind: "bathing_spot",
        lat: 59.0005,
        lon: 17.501,
        tags: {},
        provenance: "permitted",
      },
    ]);
  });

  it("grades a bathing place designated for dogs as designated", () => {
    const feature = {
      type: "Feature",
      id: "n2002",
      properties: { leisure: "bathing_place", dog: "designated" },
      geometry: { type: "Point", coordinates: [16.6, 57.75] },
    };

    expect(convertFeatures([feature])).toEqual([
      {
        id: "node/2002",
        kind: "bathing_spot",
        lat: 57.75,
        lon: 16.6,
        tags: {},
        provenance: "designated",
      },
    ]);
  });

  it("keeps a named hundbad with no dog tag as a name-match", () => {
    const feature = {
      type: "Feature",
      id: "n3003",
      properties: { natural: "water", name: "Ängsjö Hundbad" },
      geometry: { type: "Point", coordinates: [17.85, 59.55] },
    };

    expect(convertFeatures([feature])).toEqual([
      {
        id: "node/3003",
        kind: "bathing_spot",
        name: "Ängsjö Hundbad",
        lat: 59.55,
        lon: 17.85,
        tags: {},
        provenance: "name-match",
      },
    ]);
  });

  it("ignores a hundbad name outside the feature families", () => {
    // The family bound of osm-tags.ts: a street named after a hundbad is
    // not a place to swim, and both sources apply the same bound so they
    // answer alike.
    const feature = {
      type: "Feature",
      id: "w3004",
      properties: { highway: "residential", name: "Hundbadsvägen" },
      geometry: {
        type: "LineString",
        coordinates: [
          [17.0, 59.0],
          [17.01, 59.01],
        ],
      },
    };

    expect(convertFeatures([feature])).toEqual([]);
  });

  it("drops a beach that bans dogs even when the name says hundbad", () => {
    // The grading drop: a "Hundbadet" since tagged dog=no is precisely the
    // confidently wrong pin the spec forbids (§3).
    const feature = {
      type: "Feature",
      id: "n3005",
      properties: { natural: "beach", name: "Hundbadet", dog: "no" },
      geometry: { type: "Point", coordinates: [17.2, 58.9] },
    };

    expect(convertFeatures([feature])).toEqual([]);
  });

  it("ignores a park whose name merely mentions dogs", () => {
    const feature = {
      type: "Feature",
      id: "n3006",
      properties: { leisure: "park", name: "Hundparken" },
      geometry: { type: "Point", coordinates: [18.03, 59.33] },
    };

    expect(convertFeatures([feature])).toEqual([]);
  });

  it("drops a feature without a usable identity", () => {
    // Identity is non-negotiable: without an OSM id the spot cannot be
    // deduplicated against the live path or traced back to its element.
    const geometry = { type: "Point", coordinates: [18.0, 59.3] };
    const properties = { leisure: "dog_park" };
    const missingId = { type: "Feature", properties, geometry };
    const alienId = { type: "Feature", id: "x999", properties, geometry };
    const numericId = { type: "Feature", id: 999, properties, geometry };

    expect(convertFeatures([missingId, alienId, numericId])).toEqual([]);
  });

  it("drops a feature whose geometry has no usable positions", () => {
    const properties = { leisure: "dog_park" };
    const empty = {
      type: "Feature",
      id: "n7001",
      properties,
      geometry: { type: "Point", coordinates: [] },
    };
    const missing = {
      type: "Feature",
      id: "n7002",
      properties,
      geometry: null,
    };

    expect(convertFeatures([empty, missing])).toEqual([]);
  });

  it("keeps an OSM name verbatim, warts and all", () => {
    // "Category:…" is an OSM data bug, but the app renders names as OSM
    // has them — cleaning one up is an OSM edit's job, not the converter's.
    const feature = {
      type: "Feature",
      id: "n7003",
      properties: {
        leisure: "dog_park",
        name: "Category:Vanadislundens hundrastgård",
      },
      geometry: { type: "Point", coordinates: [18.05, 59.345] },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.name).toBe("Category:Vanadislundens hundrastgård");
  });

  it("parses a seasonal ban out of dog:conditional", () => {
    const feature = {
      type: "Feature",
      id: "n7004",
      properties: {
        natural: "beach",
        dog: "yes",
        "dog:conditional": "no @ (Jun 1-Aug 31)",
      },
      geometry: { type: "Point", coordinates: [18.29, 59.31] },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.seasonal).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("marks an unreadable dog:conditional as unparsed", () => {
    const feature = {
      type: "Feature",
      id: "n7005",
      properties: {
        natural: "beach",
        dog: "yes",
        "dog:conditional": "no @ (Su 10:00-18:00)",
      },
      geometry: { type: "Point", coordinates: [18.29, 59.31] },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.seasonal).toEqual({ kind: "unparsed" });
  });

  it("rounds coordinates to OSM's seven-decimal precision", () => {
    const feature = {
      type: "Feature",
      id: "n7006",
      properties: { leisure: "dog_park" },
      geometry: {
        type: "Point",
        coordinates: [18.123456789, 59.9876543211],
      },
    };

    const [spot] = convertFeatures([feature]);
    expect(spot.lon).toBe(18.1234568);
    expect(spot.lat).toBe(59.9876543);
  });

  it("sorts spots by id then kind whatever the input order", () => {
    // Code-unit order ("node/10" before "node/2"), not numeric — the sort
    // exists so regeneration is diffable, not to be pretty.
    const park = (id: string, lon: number, lat: number) => ({
      type: "Feature",
      id,
      properties: { leisure: "dog_park" },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });

    const spots = convertFeatures([
      park("w9", 18.0, 59.3),
      park("n2", 18.01, 59.31),
      park("n10", 18.02, 59.32),
    ]);

    expect(spots.map((spot) => spot.id)).toEqual([
      "node/10",
      "node/2",
      "way/9",
    ]);
  });
});

describe("buildDataset", () => {
  it("stamps the envelope the app's loader validates", () => {
    const feature = {
      type: "Feature",
      id: "n1",
      properties: { leisure: "dog_park" },
      geometry: { type: "Point", coordinates: [18.07, 59.33] },
    };

    const dataset = buildDataset({
      features: [feature],
      polyText: SWEDEN_ISH_POLY,
      region: "europe/sweden",
      generatedAt: "2026-07-21T03:00:00.000Z",
    });

    expect(dataset.schema).toBe(DATASET_SCHEMA_VERSION);
    expect(dataset.generatedAt).toBe("2026-07-21T03:00:00.000Z");
    expect(dataset.region).toBe("europe/sweden");
    expect(dataset.attribution).toBe("© OpenStreetMap contributors");
    expect(dataset.license).toBe("ODbL-1.0");
    expect(dataset.coverage).toEqual(parsePoly(SWEDEN_ISH_POLY));
    expect(dataset.spots).toHaveLength(1);
  });

  it("produces byte-identical JSON regardless of feature order", () => {
    // The weekly pipeline republishes from a fresh extract; only real OSM
    // edits should show up in a diff, never osmium's write order.
    const parkNode = {
      type: "Feature",
      id: "n1",
      properties: { leisure: "dog_park" },
      geometry: { type: "Point", coordinates: [18.07, 59.33] },
    };
    const beachWay = {
      type: "Feature",
      id: "w2",
      properties: { natural: "beach", dog: "yes" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [17.5, 59.0],
            [17.502, 59.0],
            [17.502, 59.001],
            [17.5, 59.001],
            [17.5, 59.0],
          ],
        ],
      },
    };
    const dualNode = {
      type: "Feature",
      id: "n3",
      properties: { leisure: "dog_park", name: "Hundbadplats Rönningesjön" },
      geometry: { type: "Point", coordinates: [18.1112, 59.5077] },
    };

    const asJson = (features: unknown[]) =>
      JSON.stringify(
        buildDataset({
          features,
          polyText: SWEDEN_ISH_POLY,
          region: "europe/sweden",
          generatedAt: "2026-07-21T03:00:00.000Z",
        }),
      );

    expect(asJson([parkNode, beachWay, dualNode])).toBe(
      asJson([dualNode, parkNode, beachWay]),
    );
  });
});

// ---------- assertDatasetSane ----------
//
// Synthetic datasets on purpose: the gates ask "did the filter, converter
// or geometry collapse?", and counts at positions answer that completely —
// a real extract would add bulk and a network dependency, nothing else.

const STOCKHOLM = { lat: 59.3293, lon: 18.0686 };
const MALMO = { lat: 55.605, lon: 13.0 };

/** Parks in a tight cluster (≤ ~500 m) around a center. */
function parksAround(
  center: { lat: number; lon: number },
  count: number,
): DogSpot[] {
  return Array.from({ length: count }, (_, i): DogSpot => ({
    id: `node/${i + 1}`,
    kind: "dog_park",
    lat: center.lat + (i % 10) * 0.0005,
    lon: center.lon,
    tags: {},
    provenance: "designated",
  }));
}

function bathingSpots(count: number): DogSpot[] {
  return Array.from({ length: count }, (_, i): DogSpot => ({
    id: `node/${90_000 + i}`,
    kind: "bathing_spot",
    lat: 59.5 + i * 0.01,
    lon: 18.2,
    tags: {},
    provenance: "name-match",
  }));
}

function datasetWith(spots: DogSpot[], region = "europe/sweden"): Dataset {
  return {
    schema: DATASET_SCHEMA_VERSION,
    generatedAt: "2026-07-21T03:00:00.000Z",
    region,
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    coverage: {
      include: [
        [
          [55, 10],
          [55, 25],
          [70, 25],
          [70, 10],
        ],
      ],
      exclude: [],
    },
    spots,
  };
}

describe("assertDatasetSane", () => {
  it("throws when the dataset has no spots at all", () => {
    expect(() => assertDatasetSane(datasetWith([]), "europe/sweden")).toThrow(
      /no spots at all/,
    );
  });

  it("throws when coverage has no include rings", () => {
    const dataset = {
      ...datasetWith(parksAround(STOCKHOLM, 220).concat(bathingSpots(6))),
      coverage: { include: [], exclude: [] },
    };

    expect(() => assertDatasetSane(dataset, "europe/sweden")).toThrow(
      /include rings/,
    );
  });

  it("throws for Sweden when the country has too few dog parks", () => {
    const dataset = datasetWith(
      parksAround(STOCKHOLM, 150).concat(bathingSpots(6)),
    );

    expect(() => assertDatasetSane(dataset, "europe/sweden")).toThrow(
      /only 150 dog parks/,
    );
  });

  it("throws for Sweden when Stockholm's 3 km turns up thin", () => {
    // Plenty of parks country-wide, none near Stockholm: the shape of a
    // broken distance calculation or a mangled boundary, not of the city
    // the gate was field-validated against (31 parks on 2026-07-21).
    const dataset = datasetWith(
      parksAround(MALMO, 250).concat(bathingSpots(6)),
    );

    expect(() => assertDatasetSane(dataset, "europe/sweden")).toThrow(
      /within 3 km of central Stockholm/,
    );
  });

  it("throws for Sweden when bathing spots go missing", () => {
    const dataset = datasetWith(
      parksAround(STOCKHOLM, 220).concat(bathingSpots(2)),
    );

    expect(() => assertDatasetSane(dataset, "europe/sweden")).toThrow(
      /only 2 bathing spots/,
    );
  });

  it("passes a dataset that meets every Sweden gate", () => {
    const dataset = datasetWith(
      parksAround(STOCKHOLM, 220).concat(bathingSpots(6)),
    );

    expect(() => assertDatasetSane(dataset, "europe/sweden")).not.toThrow();
  });

  it("applies only the generic gates to other regions", () => {
    // Thresholds are Sweden-specific field knowledge; a Denmark extract
    // must not be judged by Stockholm's numbers.
    const copenhagenPark: DogSpot = {
      id: "node/1",
      kind: "dog_park",
      lat: 55.6761,
      lon: 12.5683,
      tags: {},
      provenance: "designated",
    };
    const dataset = datasetWith([copenhagenPark], "europe/denmark");

    expect(() => assertDatasetSane(dataset, "europe/denmark")).not.toThrow();
  });
});
