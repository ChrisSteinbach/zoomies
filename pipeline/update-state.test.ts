import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { FILTER_VERSION } from "./filter";
import { USER_AGENT } from "./seed-state";
import type { SeedStateMeta } from "./seed-state";
import {
  assertWithinRepairBudget,
  dailyDiffUrl,
  isGoneUpstream,
  parseCheckRefs,
  planDiffSequences,
  repairFetchUrl,
  runUpdate,
  updatedStateMeta,
  validateStateMeta,
} from "./update-state";

describe("validateStateMeta", () => {
  it("accepts a state.json this pipeline can update", () => {
    const meta = validateStateMeta({
      schema: 1,
      filterVersion: FILTER_VERSION,
      sequenceNumber: 5061,
      timestamp: "2026-07-19T20:21:50.000Z",
      seededFrom: [
        { file: "sweden.osm.pbf", timestamp: "2026-07-21T20:21:50Z" },
      ],
    });

    expect(meta).toEqual({
      schema: 1,
      filterVersion: FILTER_VERSION,
      sequenceNumber: 5061,
      timestamp: "2026-07-19T20:21:50.000Z",
      seededFrom: [
        { file: "sweden.osm.pbf", timestamp: "2026-07-21T20:21:50Z" },
      ],
    });
  });

  it("throws when the schema is not 1", () => {
    expect(() =>
      validateStateMeta({
        schema: 2,
        filterVersion: FILTER_VERSION,
        sequenceNumber: 5061,
        timestamp: "2026-07-19T20:21:50.000Z",
        seededFrom: [],
      }),
    ).toThrow(/schema 2, expected 1/);
  });

  it("names both versions and demands a re-seed on a filter mismatch", () => {
    // The stale state cannot be diffed forward: objects only the new
    // expressions keep were dropped at seed time and no diff carries them.
    // The message must name both versions so the mismatch is legible in a
    // failed Actions log, and say re-seed so nobody just retries the job.
    const stale = FILTER_VERSION - 1;

    expect(() =>
      validateStateMeta({
        schema: 1,
        filterVersion: stale,
        sequenceNumber: 5061,
        timestamp: "2026-07-19T20:21:50.000Z",
        seededFrom: [],
      }),
    ).toThrow(
      new RegExp(
        `filterVersion ${stale}.*filterVersion ${FILTER_VERSION}.*re-seed`,
      ),
    );
  });

  it("throws when the sequence number is unusable", () => {
    expect(() =>
      validateStateMeta({
        schema: 1,
        filterVersion: FILTER_VERSION,
        sequenceNumber: "5061",
        timestamp: "2026-07-19T20:21:50.000Z",
        seededFrom: [],
      }),
    ).toThrow(/sequenceNumber/);
  });

  it("throws when the metadata is not an object at all", () => {
    expect(() => validateStateMeta("not json we wrote")).toThrow(
      /not an object/,
    );
  });
});

describe("updatedStateMeta", () => {
  it("advances only the replication cursor, preserving provenance", () => {
    const meta: SeedStateMeta = {
      schema: 1,
      filterVersion: FILTER_VERSION,
      sequenceNumber: 5061,
      timestamp: "2026-07-19T20:21:50.000Z",
      seededFrom: [
        { file: "sweden.osm.pbf", timestamp: "2026-07-21T20:21:50Z" },
      ],
    };

    expect(
      updatedStateMeta(meta, {
        sequenceNumber: 5063,
        timestamp: "2026-07-22T00:00:00Z",
      }),
    ).toEqual({
      schema: 1,
      filterVersion: FILTER_VERSION,
      sequenceNumber: 5063,
      timestamp: "2026-07-22T00:00:00Z",
      seededFrom: [
        { file: "sweden.osm.pbf", timestamp: "2026-07-21T20:21:50Z" },
      ],
    });
  });
});

describe("planDiffSequences", () => {
  it("plans stored+1 up to the current head, oldest first", () => {
    expect(planDiffSequences(5061, 5063, 40)).toEqual([5062, 5063]);
  });

  it("plans nothing when the state is already at the head", () => {
    expect(planDiffSequences(5061, 5061, 40)).toEqual([]);
  });

  it("accepts a backlog exactly at the budget", () => {
    expect(planDiffSequences(5061, 5101, 40)).toHaveLength(40);
  });

  it("throws on a head behind the stored sequence", () => {
    expect(() => planDiffSequences(5061, 5060, 40)).toThrow(/incoherent/);
  });

  it("throws loudly, advising a re-seed, when the backlog exceeds the budget", () => {
    expect(() => planDiffSequences(5061, 5102, 40)).toThrow(
      /41 daily diffs.*--max-diffs.*40.*re-seed/,
    );
  });
});

describe("dailyDiffUrl", () => {
  it("maps the planned sequences to their .osc.gz URLs", () => {
    // The task the seed leaves behind: 5061 stored, 5063 current, so the
    // two pending diffs live at 000/005/062 and 000/005/063.
    expect(planDiffSequences(5061, 5063, 40).map(dailyDiffUrl)).toEqual([
      "https://planet.osm.org/replication/day/000/005/062.osc.gz",
      "https://planet.osm.org/replication/day/000/005/063.osc.gz",
    ]);
  });
});

describe("parseCheckRefs", () => {
  it("derives the repair parents from osmium 1.16's real output", () => {
    // Captured verbatim from `osmium check-refs -r --show-ids` (osmium
    // 1.16.0, stdout only — the summary goes to stderr) over a fixture with
    // a way missing two nodes and a relation missing a way and a node.
    const captured = [
      "n8001 in w9001",
      "n8002 in w9001",
      "w9999 in r7001",
      "n8003 in r7001",
    ].join("\n");

    expect(parseCheckRefs(captured)).toEqual({
      missingRefs: 4,
      parents: [
        { type: "way", id: "9001" },
        { type: "relation", id: "7001" },
      ],
    });
  });

  it("deduplicates the repeated pair a closed way reports", () => {
    // Also captured for real: a closed way lists its first node twice, and
    // check-refs prints the pair once per occurrence.
    const captured = [
      "n8001 in w9001",
      "n8002 in w9001",
      "n8003 in w9001",
      "n8004 in w9001",
      "n8001 in w9001",
    ].join("\n");

    expect(parseCheckRefs(captured)).toEqual({
      missingRefs: 4,
      parents: [{ type: "way", id: "9001" }],
    });
  });

  it("reads empty output as nothing to repair", () => {
    expect(parseCheckRefs("")).toEqual({ missingRefs: 0, parents: [] });
  });

  it("throws on a line it does not recognise", () => {
    // check-refs also exits 1 on a hard failure (message on stderr) — but
    // if anything unexpected ever lands on stdout, guessing would ship an
    // incomplete repair set, so the parser must refuse.
    expect(() =>
      parseCheckRefs("Open failed for 'x.pbf': No such file or directory"),
    ).toThrow(/Unrecognised osmium check-refs output/);
  });

  it("refuses a node-shaped parent as format drift", () => {
    // Nodes reference nothing; a node on the parent side means the format
    // has changed under the parser.
    expect(() => parseCheckRefs("n1 in n2")).toThrow(
      /Unrecognised osmium check-refs output/,
    );
  });
});

describe("repairFetchUrl", () => {
  it("maps a way to its /full endpoint", () => {
    expect(repairFetchUrl({ type: "way", id: "456" })).toBe(
      "https://api.openstreetmap.org/api/0.6/way/456/full",
    );
  });

  it("maps a relation to its /full endpoint", () => {
    expect(repairFetchUrl({ type: "relation", id: "789" })).toBe(
      "https://api.openstreetmap.org/api/0.6/relation/789/full",
    );
  });
});

describe("assertWithinRepairBudget", () => {
  const parents = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      type: "way" as const,
      id: String(i + 1),
    }));

  it("accepts a repair set exactly at the budget", () => {
    expect(() => assertWithinRepairBudget(parents(300), 300)).not.toThrow();
  });

  it("throws loudly, advising a re-seed, when the set exceeds the budget", () => {
    expect(() => assertWithinRepairBudget(parents(301), 300)).toThrow(
      /301 parents.*--max-repairs.*300.*re-seed/,
    );
  });
});

describe("isGoneUpstream", () => {
  it("treats 404 and 410 as deleted upstream, worth skipping", () => {
    // A parent deleted between the diff and now: fetching cannot succeed
    // tomorrow either, and the export dropping it is the honest outcome.
    expect(isGoneUpstream(404)).toBe(true);
    expect(isGoneUpstream(410)).toBe(true);
  });

  it("treats every other failure as transient, worth failing the run", () => {
    expect(isGoneUpstream(500)).toBe(false);
    expect(isGoneUpstream(429)).toBe(false);
    expect(isGoneUpstream(200)).toBe(false);
  });
});

/**
 * INTEGRATION TEST — the one test that runs the real osmium binary, because
 * the question it answers cannot be answered from fixtures: does the whole
 * engine actually close the retagging hole? A way newly retagged into scope
 * arrives in the daily diff WITHOUT its unchanged member nodes — they are
 * in neither the filtered state nor the diff — so without the repair step
 * its geometry is unbuildable and the park silently vanishes. This test is
 * what makes the repair mechanism real rather than aspirational. Skipped
 * when osmium-tool is not on PATH; everything above runs without it.
 */
const osmiumAvailable = ((): boolean => {
  try {
    execFileSync("osmium", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("runUpdate (integration, needs osmium)", () => {
  it.skipIf(!osmiumAvailable)(
    "repairs a way newly retagged into scope and lands it in the dataset",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "zoomies-update-test-"));
      try {
        // (a) The state: one in-scope dog park node and NOTHING else —
        // in particular, none of way 9001's nodes.
        const stateXml = [
          "<?xml version='1.0' encoding='UTF-8'?>",
          '<osm version="0.6" generator="update-state-test">',
          '  <node id="100" version="1" timestamp="2026-07-01T00:00:00Z" lat="59.3293000" lon="18.0686000">',
          '    <tag k="leisure" v="dog_park"/>',
          '    <tag k="name" v="Vasaparkens hundrastgård"/>',
          "  </node>",
          "</osm>",
        ].join("\n");
        writeFileSync(join(tmp, "state.osm"), stateXml);
        execFileSync("osmium", [
          "cat",
          join(tmp, "state.osm"),
          "-o",
          join(tmp, "state.osm.pbf"),
        ]);
        writeFileSync(
          join(tmp, "state.json"),
          JSON.stringify({
            schema: 1,
            filterVersion: FILTER_VERSION,
            sequenceNumber: 5061,
            timestamp: "2026-07-19T00:00:00.000Z",
            seededFrom: [
              { file: "sweden.osm.pbf", timestamp: "2026-07-20T00:00:00Z" },
            ],
          }),
        );

        // (b) The daily diff: the known node modified, AND way 9001 newly
        // carrying leisure=dog_park — an existing way retagged into scope,
        // so the diff has the way but NOT nodes 8001–8004. The hole.
        const diffXml = [
          "<?xml version='1.0' encoding='UTF-8'?>",
          '<osmChange version="0.6" generator="update-state-test">',
          "  <modify>",
          '    <node id="100" version="2" timestamp="2026-07-21T12:00:00Z" lat="59.3294000" lon="18.0687000">',
          '      <tag k="leisure" v="dog_park"/>',
          '      <tag k="name" v="Vasaparkens hundrastgård"/>',
          "    </node>",
          "  </modify>",
          "  <modify>",
          '    <way id="9001" version="5" timestamp="2026-07-21T12:00:00Z">',
          '      <nd ref="8001"/>',
          '      <nd ref="8002"/>',
          '      <nd ref="8003"/>',
          '      <nd ref="8004"/>',
          '      <nd ref="8001"/>',
          '      <tag k="leisure" v="dog_park"/>',
          '      <tag k="name" v="Nya hundrastgården"/>',
          "    </way>",
          "  </modify>",
          "</osmChange>",
        ].join("\n");

        // (c) Way 9001's /full from the editing API: the way AND its four
        // nodes — a square whose bbox center is (59.341, 18.051).
        const fullXml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<osm version="0.6" generator="OpenStreetMap server">',
          ' <node id="8001" visible="true" version="3" changeset="1" timestamp="2026-06-01T00:00:00Z" user="t" uid="1" lat="59.3400000" lon="18.0500000"/>',
          ' <node id="8002" visible="true" version="1" changeset="1" timestamp="2026-06-01T00:00:00Z" user="t" uid="1" lat="59.3400000" lon="18.0520000"/>',
          ' <node id="8003" visible="true" version="2" changeset="1" timestamp="2026-06-01T00:00:00Z" user="t" uid="1" lat="59.3420000" lon="18.0520000"/>',
          ' <node id="8004" visible="true" version="1" changeset="1" timestamp="2026-06-01T00:00:00Z" user="t" uid="1" lat="59.3420000" lon="18.0500000"/>',
          ' <way id="9001" visible="true" version="5" changeset="2" timestamp="2026-07-21T12:00:00Z" user="t" uid="1">',
          '  <nd ref="8001"/>',
          '  <nd ref="8002"/>',
          '  <nd ref="8003"/>',
          '  <nd ref="8004"/>',
          '  <nd ref="8001"/>',
          '  <tag k="leisure" v="dog_park"/>',
          '  <tag k="name" v="Nya hundrastgården"/>',
          " </way>",
          "</osm>",
        ].join("\n");

        // The fake network: the replication head one sequence ahead of the
        // state, the gzipped diff, and the API's /full answer.
        const requests: { url: string; userAgent: string | null }[] = [];
        const fetchImpl: typeof fetch = (input, init) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          requests.push({
            url,
            userAgent: new Headers(init?.headers).get("user-agent"),
          });
          if (url === "https://planet.osm.org/replication/day/state.txt") {
            return Promise.resolve(
              new Response(
                "#Fake osmosis state\n" +
                  "sequenceNumber=5062\n" +
                  "timestamp=2026-07-22T00\\:00\\:00Z\n",
              ),
            );
          }
          if (
            url === "https://planet.osm.org/replication/day/000/005/062.osc.gz"
          ) {
            return Promise.resolve(
              new Response(new Uint8Array(gzipSync(diffXml))),
            );
          }
          if (url === "https://api.openstreetmap.org/api/0.6/way/9001/full") {
            return Promise.resolve(new Response(fullXml));
          }
          return Promise.resolve(
            new Response(`unexpected: ${url}`, { status: 500 }),
          );
        };

        const summary = await runUpdate({
          statePath: join(tmp, "state.osm.pbf"),
          metaPath: join(tmp, "state.json"),
          outStatePath: join(tmp, "next-state.osm.pbf"),
          outMetaPath: join(tmp, "next-state.json"),
          outDatasetPath: join(tmp, "dogspots.json"),
          fetchImpl,
          repairPauseMs: 0,
          // The planet gates demand a plausible world and this fixture is
          // two parks; the gates have their own unit tests in
          // convert.test.ts, and the region knob keeps them out of the
          // repair story.
          region: "integration-test",
          now: () => new Date("2026-07-22T06:00:00.000Z"),
        });

        // The dataset holds BOTH parks: the node it always had, and the
        // repaired way at its bbox center — the pin that would silently
        // have vanished without the /full fetch.
        const dataset = JSON.parse(
          readFileSync(join(tmp, "dogspots.json"), "utf8"),
        ) as {
          region: string;
          generatedAt: string;
          spots: {
            id: string;
            kind: string;
            lat: number;
            lon: number;
            name?: string;
          }[];
        };
        expect(
          dataset.spots.map((spot) => `${spot.kind} ${spot.id}`).sort(),
        ).toEqual(["dog_park node/100", "dog_park way/9001"]);
        const repaired = dataset.spots.find((spot) => spot.id === "way/9001");
        expect(repaired?.name).toBe("Nya hundrastgården");
        expect(repaired?.lat).toBeCloseTo(59.341, 6);
        expect(repaired?.lon).toBeCloseTo(18.051, 6);
        expect(dataset.region).toBe("integration-test");
        expect(dataset.generatedAt).toBe("2026-07-22T06:00:00.000Z");

        // The carried-forward state is ref-complete — tomorrow's diffs
        // apply to a base that already holds the repaired geometry.
        execFileSync("osmium", [
          "check-refs",
          "-r",
          join(tmp, "next-state.osm.pbf"),
        ]);

        // The commit point: metadata advanced to the head just replayed,
        // provenance untouched.
        const nextMeta = JSON.parse(
          readFileSync(join(tmp, "next-state.json"), "utf8"),
        ) as SeedStateMeta;
        expect(nextMeta.sequenceNumber).toBe(5062);
        expect(nextMeta.timestamp).toBe("2026-07-22T00:00:00Z");
        expect(nextMeta.filterVersion).toBe(FILTER_VERSION);
        expect(nextMeta.seededFrom).toEqual([
          { file: "sweden.osm.pbf", timestamp: "2026-07-20T00:00:00Z" },
        ]);

        expect(summary).toEqual({
          diffsApplied: 1,
          repairsFetched: 1,
          repairsSkippedGone: 0,
          unresolvedRefs: 0,
          spots: 2,
          dogParks: 2,
          bathingSpots: 0,
        });

        // Both hosts require self-identification; every request carried it.
        expect(requests.length).toBeGreaterThanOrEqual(3);
        for (const request of requests) {
          expect(request.userAgent).toBe(USER_AGENT);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
