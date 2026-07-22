import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FILTER_VERSION } from "./filter";
import {
  USER_AGENT,
  buildStateMeta,
  candidateSequence,
  mergeFilteredPbfs,
  parseReplicationState,
  resolveDailySequence,
  safetySeedTimestamp,
  sequenceStatePath,
} from "./seed-state";

describe("parseReplicationState", () => {
  it("reads the osmosis format, unescaping the timestamp's colons", () => {
    // Verbatim shape of planet.osm.org's state.txt: a #comment line, then
    // Java-properties key=value pairs whose colons arrive escaped.
    const state = parseReplicationState(
      "#Wed Jul 22 02:03:04 UTC 2026\n" +
        "sequenceNumber=5061\n" +
        "timestamp=2026-07-22T00\\:00\\:00Z\n",
    );

    expect(state).toEqual({
      sequenceNumber: 5061,
      timestamp: "2026-07-22T00:00:00Z",
    });
  });

  it("throws when sequenceNumber is missing", () => {
    expect(() =>
      parseReplicationState("timestamp=2026-07-22T00\\:00\\:00Z\n"),
    ).toThrow(/sequenceNumber/);
  });

  it("throws when the timestamp does not parse as a date", () => {
    expect(() =>
      parseReplicationState("sequenceNumber=5061\ntimestamp=not-a-date\n"),
    ).toThrow(/timestamp/);
  });
});

describe("sequenceStatePath", () => {
  it("pads to nine digits split into thirds", () => {
    expect(sequenceStatePath(5061)).toBe("000/005/061");
  });

  it("leaves a nine-digit sequence unpadded", () => {
    expect(sequenceStatePath(123456789)).toBe("123/456/789");
  });

  it("rejects a value that is not a sequence number", () => {
    expect(() => sequenceStatePath(-1)).toThrow(/sequence/);
    expect(() => sequenceStatePath(5061.5)).toThrow(/sequence/);
    expect(() => sequenceStatePath(1_000_000_000)).toThrow(/sequence/);
  });
});

describe("candidateSequence", () => {
  it("steps back one sequence per elapsed day, plus one for margin", () => {
    // 2.5 days behind the head rounds up to 3, minus one more: 5061-3-1.
    const candidate = candidateSequence(
      { sequenceNumber: 5061, timestamp: "2026-07-22T00:00:00Z" },
      "2026-07-19T12:00:00Z",
    );

    expect(candidate).toBe(5057);
  });

  it("still steps the extra margin on an exact whole-day distance", () => {
    const candidate = candidateSequence(
      { sequenceNumber: 5061, timestamp: "2026-07-22T00:00:00Z" },
      "2026-07-21T00:00:00Z",
    );

    expect(candidate).toBe(5059);
  });

  it("clamps to the first sequence for a safety time older than the history", () => {
    const candidate = candidateSequence(
      { sequenceNumber: 10, timestamp: "2026-07-22T00:00:00Z" },
      "2020-01-01T00:00:00Z",
    );

    expect(candidate).toBe(1);
  });
});

describe("safetySeedTimestamp", () => {
  it("takes the oldest region timestamp minus 24 hours", () => {
    const safety = safetySeedTimestamp([
      { file: "europe.osm.pbf", timestamp: "2026-07-21T05:00:00Z" },
      { file: "africa.osm.pbf", timestamp: "2026-07-20T10:00:00Z" },
      { file: "asia.osm.pbf", timestamp: "2026-07-21T20:00:00Z" },
    ]);

    expect(safety).toBe("2026-07-19T10:00:00.000Z");
  });

  it("throws on an empty region list", () => {
    expect(() => safetySeedTimestamp([])).toThrow(/No seeded-from/);
  });
});

describe("buildStateMeta", () => {
  it("assembles the state.json envelope around the safety timestamp", () => {
    const meta = buildStateMeta(
      [
        { file: "sweden.osm.pbf", timestamp: "2026-07-21T20:21:50Z" },
        { file: "norway.osm.pbf", timestamp: "2026-07-20T20:21:50Z" },
      ],
      5059,
    );

    expect(meta).toEqual({
      schema: 1,
      filterVersion: FILTER_VERSION,
      sequenceNumber: 5059,
      timestamp: "2026-07-19T20:21:50.000Z",
      seededFrom: [
        { file: "sweden.osm.pbf", timestamp: "2026-07-21T20:21:50Z" },
        { file: "norway.osm.pbf", timestamp: "2026-07-20T20:21:50Z" },
      ],
    });
  });
});

describe("resolveDailySequence", () => {
  /**
   * A fake planet.osm.org: answers /replication/day/state.txt with the head
   * sequence and NNN/NNN/NNN.state.txt with that sequence's timestamp, in
   * the real escaped osmosis format. Records every request so tests can
   * assert what was asked for and how.
   */
  function fakeReplication(
    headSequence: number,
    timestamps: Record<number, string>,
  ): {
    fetchImpl: typeof fetch;
    requests: { url: string; userAgent: string | null }[];
  } {
    const requests: { url: string; userAgent: string | null }[] = [];
    const stateText = (sequence: number): string => {
      const timestamp = timestamps[sequence];
      if (timestamp === undefined) {
        throw new Error(`test fake has no state for sequence ${sequence}`);
      }
      return (
        "#Fake osmosis state\n" +
        `sequenceNumber=${sequence}\n` +
        `timestamp=${timestamp.replaceAll(":", "\\:")}\n`
      );
    };
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
      const match = /(\d{3})\/(\d{3})\/(\d{3})\.state\.txt$/.exec(url);
      const sequence = match
        ? Number(`${match[1]}${match[2]}${match[3]}`)
        : headSequence;
      return Promise.resolve(new Response(stateText(sequence)));
    };
    return { fetchImpl, requests };
  }

  it("walks up to the newest sequence at or before the safety time", async () => {
    // The guess lands at 5057 (2.5 days -> 3, minus 1), but replication
    // skipped a day before 5060, so the true answer sits two steps up:
    // ts(5059) <= safety < ts(5060).
    const { fetchImpl } = fakeReplication(5061, {
      5057: "2026-07-17T00:00:00Z",
      5058: "2026-07-18T00:00:00Z",
      5059: "2026-07-19T00:00:00Z",
      5060: "2026-07-21T00:00:00Z",
      5061: "2026-07-22T00:00:00Z",
    });

    await expect(
      resolveDailySequence("2026-07-19T12:00:00Z", fetchImpl),
    ).resolves.toBe(5059);
  });

  it("walks down when the guess lands after the safety time", async () => {
    // The guess lands at 5058, whose state is newer than the safety time,
    // so the answer is one step down: ts(5057) <= safety < ts(5058).
    const { fetchImpl } = fakeReplication(5061, {
      5057: "2026-07-20T06:00:00Z",
      5058: "2026-07-21T06:00:00Z",
      5061: "2026-07-22T06:00:00Z",
    });

    await expect(
      resolveDailySequence("2026-07-21T00:00:00Z", fetchImpl),
    ).resolves.toBe(5057);
  });

  it("answers the head itself when the safety time is not behind it", async () => {
    const { fetchImpl, requests } = fakeReplication(5061, {
      5061: "2026-07-22T00:00:00Z",
    });

    await expect(
      resolveDailySequence("2026-07-23T00:00:00Z", fetchImpl),
    ).resolves.toBe(5061);
    expect(requests).toHaveLength(1);
  });

  it("sends the descriptive User-Agent on every request", async () => {
    const { fetchImpl, requests } = fakeReplication(5061, {
      5057: "2026-07-17T00:00:00Z",
      5058: "2026-07-18T00:00:00Z",
      5059: "2026-07-19T00:00:00Z",
      5060: "2026-07-21T00:00:00Z",
      5061: "2026-07-22T00:00:00Z",
    });

    await resolveDailySequence("2026-07-19T12:00:00Z", fetchImpl);

    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(request.userAgent).toBe(USER_AGENT);
    }
  });
});

describe("regions.json", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("./regions.json", import.meta.url), "utf8"),
  ) as {
    generated: string;
    note: string;
    regions: { id: string; pbf: string; approxBytes: number }[];
  };

  it("documents when it was generated and how to regenerate it", () => {
    expect(Number.isNaN(Date.parse(manifest.generated))).toBe(false);
    expect(manifest.note).toMatch(/[Rr]egenerate/);
  });

  it("lists only https Geofabrik .osm.pbf files under the 5 GB runner cap", () => {
    expect(manifest.regions.length).toBeGreaterThan(0);
    for (const region of manifest.regions) {
      expect(region.pbf).toMatch(/^https:\/\//);
      expect(region.pbf).toMatch(/\.osm\.pbf$/);
      expect(region.approxBytes).toBeGreaterThan(0);
      expect(region.approxBytes).toBeLessThanOrEqual(5 * 1024 ** 3);
    }
  });

  it("covers no region twice", () => {
    const ids = manifest.regions.map((region) => region.id);
    expect(new Set(ids).size).toBe(ids.length);

    const urls = manifest.regions.map((region) => region.pbf);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

/**
 * INTEGRATION TEST — the one test that runs the real osmium binary, because
 * the question it answers cannot be answered from fixtures: how the merge
 * chain treats the same object appearing in two region files at different
 * versions (Geofabrik regions overlap at borders and are cut at slightly
 * different times). Skipped when osmium-tool is not on PATH; everything
 * else in this file runs without it.
 */
const osmiumAvailable = ((): boolean => {
  try {
    execFileSync("osmium", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("mergeFilteredPbfs (integration, needs osmium)", () => {
  it.skipIf(!osmiumAvailable)(
    "collapses cross-file duplicates to the newest version, either input order",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "zoomies-seed-test-"));
      try {
        // Region A: node 1 and way 10 at version 1, plus border node 2.
        const regionA = [
          "<?xml version='1.0' encoding='UTF-8'?>",
          '<osm version="0.6" generator="seed-state-test">',
          '  <node id="1" version="1" timestamp="2026-07-01T00:00:00Z" lat="59.3000000" lon="18.0000000">',
          '    <tag k="leisure" v="dog_park"/>',
          '    <tag k="name" v="Old Name"/>',
          "  </node>",
          '  <node id="2" version="1" timestamp="2026-07-01T00:00:00Z" lat="59.3100000" lon="18.0100000"/>',
          '  <way id="10" version="1" timestamp="2026-07-01T00:00:00Z">',
          '    <nd ref="1"/>',
          '    <nd ref="2"/>',
          '    <tag k="name" v="Old Way"/>',
          "  </way>",
          "</osm>",
        ].join("\n");

        // Region B, cut nine days later: node 1 and way 10 at version 2,
        // node 2 identical to region A's copy (the same-version overlap
        // case), and node 3 that only this region has.
        const regionB = [
          "<?xml version='1.0' encoding='UTF-8'?>",
          '<osm version="0.6" generator="seed-state-test">',
          '  <node id="1" version="2" timestamp="2026-07-10T00:00:00Z" lat="59.3005000" lon="18.0005000">',
          '    <tag k="leisure" v="dog_park"/>',
          '    <tag k="name" v="New Name"/>',
          "  </node>",
          '  <node id="2" version="1" timestamp="2026-07-01T00:00:00Z" lat="59.3100000" lon="18.0100000"/>',
          '  <node id="3" version="1" timestamp="2026-07-10T00:00:00Z" lat="59.3200000" lon="18.0200000"/>',
          '  <way id="10" version="2" timestamp="2026-07-10T00:00:00Z">',
          '    <nd ref="1"/>',
          '    <nd ref="2"/>',
          '    <tag k="name" v="New Way"/>',
          "  </way>",
          "</osm>",
        ].join("\n");

        writeFileSync(join(tmp, "a.osm"), regionA);
        writeFileSync(join(tmp, "b.osm"), regionB);
        const aPbf = join(tmp, "a.osm.pbf");
        const bPbf = join(tmp, "b.osm.pbf");
        execFileSync("osmium", ["cat", join(tmp, "a.osm"), "-o", aPbf]);
        execFileSync("osmium", ["cat", join(tmp, "b.osm"), "-o", bPbf]);

        for (const inputs of [
          [aPbf, bPbf],
          [bPbf, aPbf],
        ]) {
          const merged = join(tmp, "state.osm.pbf");
          mergeFilteredPbfs(inputs, merged);
          const xml = execFileSync("osmium", ["cat", merged, "-f", "osm"], {
            encoding: "utf8",
          });

          // The shared node and way exist once each, at version 2.
          expect(xml.match(/<node id="1" /g)).toHaveLength(1);
          expect(xml).toContain('<node id="1" version="2"');
          expect(xml).toContain("New Name");
          expect(xml).not.toContain("Old Name");
          expect(xml.match(/<way id="10" /g)).toHaveLength(1);
          expect(xml).toContain('<way id="10" version="2"');
          expect(xml).toContain("New Way");
          expect(xml).not.toContain("Old Way");

          // The same-version overlap collapsed, and each region's own
          // objects survived.
          expect(xml.match(/<node id="2" /g)).toHaveLength(1);
          expect(xml.match(/<node id="3" /g)).toHaveLength(1);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
