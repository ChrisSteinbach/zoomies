import type { CoverageArea, Ring } from "./coverage";
import { circleWithinCoverage } from "./coverage";

describe("circleWithinCoverage", () => {
  // Most tests use a square include ring around Stockholm — lat 58.9 to
  // 59.7, lon 17.5 to 18.7 — queried from (59.33, 18.06). From there the
  // nearest boundary is the west edge at lon 17.5:
  //   0.56° × 111.2 km/° × cos(59.33°) ≈ 31.8 km
  // and the nearest latitude edge is the north one at lat 59.7:
  //   0.37° × 111.2 km/° ≈ 41.1 km.
  // Asserted radii sit kilometres clear of every edge, so no plausible
  // variation in the distance model can flip an assertion.

  it("answers true when the circle fits inside with room to spare", () => {
    const stockholmSquare: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    const coverage: CoverageArea = { include: [stockholmSquare], exclude: [] };

    // Nearest boundary ≈ 31.8 km away; a 25 km circle is well short of it.
    expect(
      circleWithinCoverage({ lat: 59.33, lon: 18.06 }, 25_000, coverage),
    ).toBe(true);
  });

  it("answers false when the radius reaches past the nearest edge", () => {
    const stockholmSquare: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    const coverage: CoverageArea = { include: [stockholmSquare], exclude: [] };

    // 34 km overshoots the ≈ 31.8 km west edge by over 2 km: the circle
    // crosses into ground the dataset does not have, so it must not answer.
    expect(
      circleWithinCoverage({ lat: 59.33, lon: 18.06 }, 34_000, coverage),
    ).toBe(false);
  });

  it("answers false for a centre outside coverage, even at a tiny radius", () => {
    const stockholmSquare: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    const coverage: CoverageArea = { include: [stockholmSquare], exclude: [] };

    // Copenhagen. Even a 100 m question is not this dataset's to answer.
    expect(
      circleWithinCoverage({ lat: 55.68, lon: 12.57 }, 100, coverage),
    ).toBe(false);
  });

  it("answers false inside the bounding box but outside the ring", () => {
    // The Stockholm square with its south-east corner bitten out — an
    // L-shape, whose bounding box is bigger than itself the way Sweden's
    // contains Copenhagen and Oslo.
    const bittenSquare: Ring = [
      [58.9, 17.5],
      [58.9, 18.1],
      [59.3, 18.1],
      [59.3, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    const coverage: CoverageArea = { include: [bittenSquare], exclude: [] };

    // (59.0, 18.5) sits in the bite: inside lat 58.9–59.7 × lon 17.5–18.7,
    // outside the ring. A bounding-box shortcut would answer "covered" here
    // — the confidently-wrong case the polygon test exists to refuse.
    expect(circleWithinCoverage({ lat: 59.0, lon: 18.5 }, 100, coverage)).toBe(
      false,
    );
  });

  it("answers false for a centre inside an exclude ring", () => {
    const stockholmSquare: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    // A hole cut around the centre: ground the extract was built without.
    const hole: Ring = [
      [59.2, 17.9],
      [59.2, 18.3],
      [59.5, 18.3],
      [59.5, 17.9],
      [59.2, 17.9],
    ];
    const coverage: CoverageArea = {
      include: [stockholmSquare],
      exclude: [hole],
    };

    expect(
      circleWithinCoverage({ lat: 59.33, lon: 18.06 }, 1_000, coverage),
    ).toBe(false);
  });

  it("answers false when a hole's boundary lies within the radius", () => {
    const stockholmSquare: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    // A hole north of the centre, not containing it: its south edge at
    // lat 59.35 is 0.02° × 111.2 km/° ≈ 2.2 km from (59.33, 18.06).
    const hole: Ring = [
      [59.35, 18.0],
      [59.35, 18.2],
      [59.45, 18.2],
      [59.45, 18.0],
      [59.35, 18.0],
    ];
    const coverage: CoverageArea = {
      include: [stockholmSquare],
      exclude: [hole],
    };

    // Without the hole, 10 km fits easily (the outer ring is ≈ 31.8 km
    // off). The hole ≈ 2.2 km away shrinks what can be answered from here.
    expect(
      circleWithinCoverage({ lat: 59.33, lon: 18.06 }, 10_000, coverage),
    ).toBe(false);
  });

  it("reads a ring without the closing repeated point as the same ring", () => {
    // The same square, spelled both ways .poly files appear in the wild:
    // with the traditional closing repeat, and without it.
    const closed: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    const open: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
    ];
    const answer = (ring: Ring, radiusM: number) =>
      circleWithinCoverage({ lat: 59.33, lon: 18.06 }, radiusM, {
        include: [ring],
        exclude: [],
      });

    // Same calls on both sides of the ≈ 31.8 km west edge. In the open
    // spelling that edge is exactly the implicit last-to-first one — the
    // edge a ring-closing bug would lose.
    expect(answer(closed, 25_000)).toBe(true);
    expect(answer(open, 25_000)).toBe(true);
    expect(answer(closed, 34_000)).toBe(false);
    expect(answer(open, 34_000)).toBe(false);
  });

  it("answers false when there are no include rings", () => {
    // No rings, no coverage: an empty dataset claims nothing, not
    // everything.
    const coverage: CoverageArea = { include: [], exclude: [] };

    expect(
      circleWithinCoverage({ lat: 59.33, lon: 18.06 }, 100, coverage),
    ).toBe(false);
  });

  it("answers false when the circle reaches a neighbouring include ring", () => {
    // Two disjoint squares with a ≈ 5.7 km strip of uncovered ground
    // between them (lon 17.4 to 17.5). From (59.33, 17.65), inside the
    // eastern square:
    //   own west edge   lon 17.5: 0.15° × 111.2 km/° × cos(59.33°) ≈  8.5 km
    //   neighbour edge  lon 17.4: 0.25° × 111.2 km/° × cos(59.33°) ≈ 14.2 km
    // A 20 km circle reaches both edges — and the uncovered strip between
    // them — so offline must not answer, however close the neighbour is.
    const east: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    const west: Ring = [
      [58.9, 16.0],
      [58.9, 17.4],
      [59.7, 17.4],
      [59.7, 16.0],
      [58.9, 16.0],
    ];
    const coverage: CoverageArea = { include: [east, west], exclude: [] };

    expect(
      circleWithinCoverage({ lat: 59.33, lon: 17.65 }, 20_000, coverage),
    ).toBe(false);
  });

  it("answers false at the seam of two touching include rings", () => {
    // The squares share the lon 17.5 edge, so their union covers the whole
    // 15 km circle around (59.33, 17.65) — yet the shared edge is still a
    // ring boundary, ≈ 8.5 km away (0.15° × 111.2 km/° × cos(59.33°)), and
    // the rule measures against every boundary. Deliberately conservative:
    // refusing at a seam costs one live query, never a wrong answer.
    const east: Ring = [
      [58.9, 17.5],
      [58.9, 18.7],
      [59.7, 18.7],
      [59.7, 17.5],
      [58.9, 17.5],
    ];
    const west: Ring = [
      [58.9, 16.3],
      [58.9, 17.5],
      [59.7, 17.5],
      [59.7, 16.3],
      [58.9, 16.3],
    ];
    const coverage: CoverageArea = { include: [east, west], exclude: [] };

    expect(
      circleWithinCoverage({ lat: 59.33, lon: 17.65 }, 15_000, coverage),
    ).toBe(false);
  });
});
