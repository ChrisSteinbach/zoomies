import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLANET_REGION, assertDatasetSane, buildDataset } from "./convert";
import { FILTER_EXPRESSIONS, FILTER_VERSION } from "./filter";
import {
  USER_AGENT,
  mergeFilteredPbfs,
  parseReplicationState,
} from "./seed-state";
import { sequenceStatePath } from "./seed-state";
import type {
  ReplicationState,
  SeedStateMeta,
  SeededFromEntry,
} from "./seed-state";

/**
 * The daily update engine for the global offline state (docs/spec.md §5):
 * applies planet daily replication diffs to the seeded state file, repairs
 * the geometry the diffs cannot carry, and rebuilds the published planet
 * dataset. See USAGE for the invocation; `npm run data:update` wraps it.
 *
 * The pipeline: `osmium apply-changes` (every pending daily diff, oldest
 * first) → `osmium tags-filter` (restores minimality — a daily diff carries
 * the whole planet's edits, and re-filtering drops the millions of
 * out-of-scope objects the merge pulled in, along with anything retagged
 * OUT of scope) → the repair loop → `osmium export` → convert.ts.
 *
 * The repair loop closes this path's one soundness hole. When an existing
 * way or relation is newly retagged INTO scope, the diff carries the parent
 * object but not its unchanged member nodes and ways — replication diffs
 * list changed objects only. The filtered state has never held those
 * members, so the parent's geometry is unbuildable and the feature would
 * silently vanish from the dataset: precisely the confident wrong answer
 * the spec forbids (§3). So after re-filtering, `osmium check-refs`
 * enumerates the incomplete parents, each parent's full geometry is fetched
 * once from the OSM editing API (/way/<id>/full, /relation/<id>/full), the
 * fetched XML is merged in with the seed's newest-version-wins merge
 * (mergeFilteredPbfs — exactly the right semantics, since the API may
 * return a newer version than the diff carried), and the check runs again.
 * Whatever is still incomplete after {@link MAX_REPAIR_PASSES} is logged
 * and tolerated, because the export skips what it cannot build — fewer
 * results beat wrong ones.
 *
 * Deliberately thin, like seed-state.ts: every decision that can be wrong —
 * metadata validation, diff planning, check-refs parsing, the repair
 * budget, the gone-upstream call — is a pure exported function, unit-tested
 * in update-state.test.ts, and the whole flow is callable as
 * {@link runUpdate} with an injected fetch so the integration test can
 * drive it offline. Write ordering is the commit protocol: the dataset and
 * the state file are written first and the metadata LAST, so a run that
 * dies partway leaves the old metadata pointing at the old state and the
 * next run simply replays. An already-current state is not an error: the
 * dataset is still rebuilt, because the converter and its gates may have
 * changed since yesterday — the job is idempotent.
 */

const USAGE = [
  "Usage:",
  "  npx tsx pipeline/update-state.ts --state <in.osm.pbf> --meta <in-state.json>",
  "    --out-state <out.osm.pbf> --out-meta <out-state.json> --out-dataset <dogspots.json>",
  "    [--max-diffs 40] [--max-repairs 300]",
  "",
  "  --state        the current filtered global state file",
  "  --meta         its replication metadata (state.json, from seed-state.ts merge)",
  "  --out-state    where to write the updated state file",
  "  --out-meta     where to write the updated metadata — written last, as the commit point",
  "  --out-dataset  where to write the rebuilt planet dataset JSON",
  "  --max-diffs    refuse to replay more than this many daily diffs (default 40)",
  "  --max-repairs  refuse to fetch more than this many /full geometries per pass (default 300)",
].join("\n");

/**
 * Where the daily planet diffs and their state files live. Mirrors
 * seed-state.ts's deliberately-private constant; these two modules are the
 * only places allowed to know it. Redirects to S3.
 */
const DAILY_REPLICATION_BASE = "https://planet.osm.org/replication/day";

/**
 * The OSM editing API, used only by the repair step and only to read.
 * Not Overpass: /full is the one endpoint that returns a parent together
 * with every member it needs — exactly the shape the repair must merge in.
 */
const OSM_API_BASE = "https://api.openstreetmap.org/api/0.6";

/**
 * Refuse to replay more than this many daily diffs by default. A state six
 * weeks behind costs more to download and apply than a fresh seed, and
 * every extra diff widens the window for replication irregularities —
 * re-seeding is the honest reset, and the throw says so.
 */
const DEFAULT_MAX_DIFFS = 40;

/**
 * Refuse to fetch more than this many /full geometries per repair pass by
 * default. Normal daily retagging churn measures in the tens; hundreds
 * means upstream chaos or a broken state file, and a re-seed is cheaper
 * and kinder than thousands of sequential editing-API calls.
 */
const DEFAULT_MAX_REPAIRS = 300;

/**
 * Gap between sequential /full fetches. The editing API is shared
 * infrastructure for actual mapping; a batch job has no business arriving
 * faster than a human editor would.
 */
const REPAIR_PAUSE_MS = 200;

/**
 * Repair rounds before giving up. One round closes the retagging hole; the
 * second covers what the first round's own fetches expose —
 * /relation/<id>/full returns child relations without THEIR members, so a
 * nested relation can surface newly incomplete. Deeper nesting than that is
 * vanishingly rare among dog parks, and the export skips what it cannot
 * build, so the remainder is logged and tolerated rather than chased.
 */
const MAX_REPAIR_PASSES = 2;

/**
 * The world as the dataset's coverage input, resolved next to this file so
 * the job can run from any cwd. The app's coverage math conservatively
 * refuses circles within ~25 km of the antimeridian and the poles, which is
 * acceptable and documented in src/app/coverage.ts.
 */
const PLANET_POLY_PATH = fileURLToPath(
  new URL("./planet.poly", import.meta.url),
);

// ---------- The stored metadata, validated ----------

/**
 * The state.json next to the state file, checked before anything is
 * downloaded or run. The filterVersion gate is the one that matters: a
 * state filtered under old expressions is silently missing every object
 * only the new expressions keep, and no amount of diff replay can put those
 * back — the diffs only carry what changed. The error names both versions
 * so the fix (re-seed, not retry) is unmistakable.
 */
export function validateStateMeta(value: unknown): SeedStateMeta {
  if (!isRecord(value)) {
    throw new Error(
      "state metadata is not an object — was it written by `seed-state.ts merge`?",
    );
  }
  if (value.schema !== 1) {
    throw new Error(
      `state metadata has schema ${String(value.schema)}, expected 1 — this pipeline cannot read it`,
    );
  }
  if (value.filterVersion !== FILTER_VERSION) {
    throw new Error(
      `state was filtered under filterVersion ${String(value.filterVersion)} but this pipeline is at filterVersion ${FILTER_VERSION} — ` +
        "a re-seed is required: a state filtered under the old expressions is silently missing every object " +
        "only the new expressions keep, and applying diffs cannot repair that.",
    );
  }
  const sequenceNumber = value.sequenceNumber;
  if (
    typeof sequenceNumber !== "number" ||
    !Number.isInteger(sequenceNumber) ||
    sequenceNumber < 1
  ) {
    throw new Error(
      `state metadata has no usable sequenceNumber: ${String(sequenceNumber)}`,
    );
  }
  const timestamp = value.timestamp;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(
      `state metadata has no usable timestamp: ${String(timestamp)}`,
    );
  }
  return {
    schema: 1,
    filterVersion: FILTER_VERSION,
    sequenceNumber,
    timestamp,
    seededFrom: toSeededFrom(value.seededFrom),
  };
}

function toSeededFrom(value: unknown): SeededFromEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "state metadata has no seededFrom list — was it written by `seed-state.ts merge`?",
    );
  }
  const entries: unknown[] = value;
  return entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.timestamp !== "string"
    ) {
      throw new Error(
        `state metadata seededFrom entry is not {file, timestamp}: ${JSON.stringify(entry) ?? "undefined"}`,
      );
    }
    return { file: entry.file, timestamp: entry.timestamp };
  });
}

/**
 * The metadata to write after a successful run: the same envelope advanced
 * to the replication head that was just replayed. Everything else — the
 * filterVersion, the seeded-from provenance — carries forward unchanged.
 */
export function updatedStateMeta(
  meta: SeedStateMeta,
  current: ReplicationState,
): SeedStateMeta {
  return {
    ...meta,
    sequenceNumber: current.sequenceNumber,
    timestamp: current.timestamp,
  };
}

// ---------- Planning the diff replay ----------

/**
 * The daily sequences to apply, oldest first: stored+1 up to and including
 * the current head. Empty when the state is already at the head — the
 * caller still rebuilds the dataset, it just has no diffs to apply.
 *
 * A head BEHIND the stored sequence cannot happen from a coherent mirror;
 * acting on it would mean replaying history backwards, so it throws. A
 * backlog over `maxDiffs` throws too, advising the cheaper fix.
 */
export function planDiffSequences(
  stored: number,
  current: number,
  maxDiffs: number,
): number[] {
  if (current < stored) {
    throw new Error(
      `Replication head is at sequence ${current}, behind the state's ${stored} — ` +
        "incoherent history; refusing to touch the state",
    );
  }
  const count = current - stored;
  if (count > maxDiffs) {
    throw new Error(
      `${count} daily diffs to replay (${stored} → ${current}) exceeds the --max-diffs budget of ${maxDiffs} — ` +
        "a state this far behind is cheaper and safer to re-seed than to update",
    );
  }
  return Array.from({ length: count }, (_, at) => stored + 1 + at);
}

/** One daily diff's URL — the replication path with .osc.gz appended. */
export function dailyDiffUrl(sequence: number): string {
  return `${DAILY_REPLICATION_BASE}/${sequenceStatePath(sequence)}.osc.gz`;
}

// ---------- check-refs, parsed ----------

export interface RepairParent {
  type: "way" | "relation";
  id: string;
}

export interface CheckRefsReport {
  /** Distinct missing (child, parent) pairs — the honest damage count. */
  missingRefs: number;
  /** The parents to repair, deduplicated, in first-seen order. */
  parents: RepairParent[];
}

/**
 * Parses `osmium check-refs -r --show-ids` stdout. Captured verbatim from
 * osmium 1.16.0 over a fixture with a way missing two nodes and a relation
 * missing a way and a node (update-state.test.ts pins the sample):
 *
 *   n8001 in w9001
 *   n8002 in w9001
 *   w9999 in r7001
 *   n8003 in r7001
 *
 * One line per missing reference, `<child> in <parent>`, ids prefixed
 * n/w/r; the human-readable summary ("Nodes in ways missing: 2") goes to
 * stderr, not here. A closed way lists its first node twice and check-refs
 * prints the pair once per occurrence — also captured — so pairs are
 * deduplicated before they are counted.
 *
 * The parent grammar accepts only ways and relations: nodes reference
 * nothing, so a node-shaped parent — or any other line — means the format
 * has changed under us, and the only safe answer is a loud throw. A parser
 * that shrugged would ship a silently incomplete repair set.
 */
const CHECK_REFS_LINE = /^([nwr])(\d+) in ([wr])(\d+)$/;

const PARENT_TYPE_BY_PREFIX: Readonly<Record<string, "way" | "relation">> = {
  w: "way",
  r: "relation",
};

export function parseCheckRefs(stdout: string): CheckRefsReport {
  const pairs = new Set<string>();
  const parentKeys = new Set<string>();
  const parents: RepairParent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = CHECK_REFS_LINE.exec(trimmed);
    if (!match) {
      throw new Error(
        `Unrecognised osmium check-refs output line: "${trimmed}" — ` +
          "the parser is written against osmium 1.16's format and must not guess",
      );
    }
    pairs.add(trimmed);
    const parentKey = `${match[3]}${match[4]}`;
    if (!parentKeys.has(parentKey)) {
      parentKeys.add(parentKey);
      parents.push({ type: PARENT_TYPE_BY_PREFIX[match[3]], id: match[4] });
    }
  }
  return { missingRefs: pairs.size, parents };
}

/** Where a parent's complete geometry lives on the editing API. */
export function repairFetchUrl(parent: RepairParent): string {
  return `${OSM_API_BASE}/${parent.type}/${parent.id}/full`;
}

/**
 * The brake between a bad day and a thousand API calls: a repair set this
 * large is not retagging churn, it is upstream chaos or a broken state
 * file, and a re-seed answers both for less than the fetches would cost.
 */
export function assertWithinRepairBudget(
  parents: readonly RepairParent[],
  maxRepairs: number,
): void {
  if (parents.length > maxRepairs) {
    throw new Error(
      `${parents.length} parents need geometry repairs, over the --max-repairs budget of ${maxRepairs} — ` +
        "upstream chaos or a broken state; re-seed instead of hammering the editing API",
    );
  }
}

/**
 * Whether a /full fetch's status means the parent no longer exists
 * upstream: deleted (410 once deleted, 404 for ids that never resolve)
 * between the diff and now. Skipping it is the honest outcome — the export
 * drops what cannot be built — where any other failure is transient and
 * should fail the run loudly so the next scheduled run retries.
 */
export function isGoneUpstream(status: number): boolean {
  return status === 404 || status === 410;
}

// ---------- The engine ----------

export interface UpdateOptions {
  statePath: string;
  metaPath: string;
  outStatePath: string;
  outMetaPath: string;
  outDatasetPath: string;
  maxDiffs?: number;
  maxRepairs?: number;
  /** Injected so tests can drive every response shape without a network,
   *  exactly as in seed-state.ts. */
  fetchImpl?: typeof fetch;
  /** Gap between /full fetches; tests pass 0. */
  repairPauseMs?: number;
  /**
   * Region stamped into the dataset and keying its sanity gates. Defaults
   * to the planet, and the CLI does not expose it: it exists so the
   * integration test can drive the whole engine over a two-park fixture
   * without fabricating a gate-plausible planet — the gates themselves are
   * unit-tested in convert.test.ts.
   */
  region?: string;
  /** The clock, injectable so runs are deterministic under test. */
  now?: () => Date;
}

export interface UpdateSummary {
  diffsApplied: number;
  repairsFetched: number;
  repairsSkippedGone: number;
  unresolvedRefs: number;
  spots: number;
  dogParks: number;
  bathingSpots: number;
}

export async function runUpdate(
  options: UpdateOptions,
): Promise<UpdateSummary> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const maxDiffs = options.maxDiffs ?? DEFAULT_MAX_DIFFS;
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const pauseMs = options.repairPauseMs ?? REPAIR_PAUSE_MS;
  const region = options.region ?? PLANET_REGION;
  const now = options.now ?? (() => new Date());

  // (a) Validate the metadata before spending a byte of network or CPU.
  const rawMeta: unknown = JSON.parse(readFileSync(options.metaPath, "utf8"));
  const meta = validateStateMeta(rawMeta);

  // (b) Where replication stands today, and the replay plan.
  const current = parseReplicationState(
    await fetchText(`${DAILY_REPLICATION_BASE}/state.txt`, fetchImpl),
  );
  const sequences = planDiffSequences(
    meta.sequenceNumber,
    current.sequenceNumber,
    maxDiffs,
  );

  const tmp = mkdtempSync(join(tmpdir(), "zoomies-update-"));
  try {
    // (c, d) Replay the pending diffs onto the state, then re-filter. The
    // state file itself is never modified: every intermediate lands in tmp.
    let workingPbf = options.statePath;
    if (sequences.length === 0) {
      console.log(
        `State is already at daily sequence ${current.sequenceNumber}; rebuilding the dataset only`,
      );
    } else {
      const diffPaths: string[] = [];
      for (const sequence of sequences) {
        const diffPath = join(tmp, `${sequence}.osc.gz`);
        console.log(
          `Fetching daily diff ${sequence}: ${dailyDiffUrl(sequence)}`,
        );
        await fetchToFile(dailyDiffUrl(sequence), diffPath, fetchImpl);
        diffPaths.push(diffPath);
      }
      // Ascending sequence order on the command line IS the application
      // order; where the same object changed twice, the later diff wins.
      const mergedPbf = join(tmp, "merged.osm.pbf");
      run("osmium", [
        "apply-changes",
        options.statePath,
        ...diffPaths,
        "-o",
        mergedPbf,
        "--overwrite",
      ]);
      const refilteredPbf = join(tmp, "refiltered.osm.pbf");
      run("osmium", [
        "tags-filter",
        mergedPbf,
        ...FILTER_EXPRESSIONS,
        "-o",
        refilteredPbf,
        "--overwrite",
      ]);
      workingPbf = refilteredPbf;
    }

    // (e) The repair loop; see the module comment for why it exists.
    const attempted = new Set<string>();
    let repairsFetched = 0;
    let repairsSkippedGone = 0;
    let apiCalls = 0;
    let report = checkRefs(workingPbf);
    for (
      let pass = 1;
      pass <= MAX_REPAIR_PASSES && report.parents.length > 0;
      pass += 1
    ) {
      // A parent already fetched and still incomplete (a 404, or geometry
      // the API itself could not close) cannot be fixed by fetching again.
      const targets = report.parents.filter(
        (parent) => !attempted.has(`${parent.type}/${parent.id}`),
      );
      if (targets.length === 0) break;
      assertWithinRepairBudget(report.parents, maxRepairs);

      const repairFiles: string[] = [];
      for (const target of targets) {
        if (apiCalls > 0) await pause(pauseMs);
        apiCalls += 1;
        attempted.add(`${target.type}/${target.id}`);
        const url = repairFetchUrl(target);
        const response = await fetchImpl(url, {
          redirect: "follow",
          headers: { "User-Agent": USER_AGENT },
        });
        if (isGoneUpstream(response.status)) {
          console.log(
            `${target.type} ${target.id} is gone upstream (HTTP ${response.status}) — ` +
              "skipped; the export drops what cannot be built",
          );
          repairsSkippedGone += 1;
          continue;
        }
        if (!response.ok) {
          throw new Error(`GET ${url} failed: ${response.status}`);
        }
        const repairPath = join(tmp, `repair-${target.type}-${target.id}.osm`);
        writeFileSync(repairPath, await response.text());
        repairFiles.push(repairPath);
        repairsFetched += 1;
      }

      if (repairFiles.length > 0) {
        const repairedPbf = join(tmp, `repaired-${pass}.osm.pbf`);
        mergeFilteredPbfs([workingPbf, ...repairFiles], repairedPbf);
        workingPbf = repairedPbf;
      }
      report = checkRefs(workingPbf);
    }
    if (report.missingRefs > 0) {
      console.log(
        `${report.missingRefs} missing references remain after repairs — ` +
          "tolerated; the export drops what cannot be built",
      );
    }

    // (f) Export and rebuild the dataset. --show-errors pins the verified
    // 1.16.0 behaviour we rely on: an object whose geometry cannot be built
    // (missing node locations, unassemblable areas) is skipped with a note
    // on stderr and the exit stays 0 — one broken way must not kill the
    // daily build, which is what --stop-on-error would do.
    const geojsonPath = join(tmp, "features.geojson");
    run("osmium", [
      "export",
      workingPbf,
      "-o",
      geojsonPath,
      "--overwrite",
      "--add-unique-id=type_id",
      "--show-errors",
    ]);
    const dataset = buildDataset({
      features: readFeatures(geojsonPath),
      polyText: readFileSync(PLANET_POLY_PATH, "utf8"),
      region,
      generatedAt: now().toISOString(),
    });
    assertDatasetSane(dataset, region);
    // Compact on purpose: the file ships over the network on first open.
    writeFileSync(options.outDatasetPath, JSON.stringify(dataset));

    // (g) State, then metadata LAST: the metadata is the commit point, and
    // metadata pointing at a state that does not exist would be a lie the
    // next run acts on (same ordering rationale as seed-state.ts).
    if (resolve(workingPbf) !== resolve(options.outStatePath)) {
      copyFileSync(workingPbf, options.outStatePath);
    }
    writeFileSync(
      options.outMetaPath,
      `${JSON.stringify(updatedStateMeta(meta, current), null, 2)}\n`,
    );

    const dogParks = dataset.spots.filter(
      (spot) => spot.kind === "dog_park",
    ).length;
    const summary: UpdateSummary = {
      diffsApplied: sequences.length,
      repairsFetched,
      repairsSkippedGone,
      unresolvedRefs: report.missingRefs,
      spots: dataset.spots.length,
      dogParks,
      bathingSpots: dataset.spots.length - dogParks,
    };
    console.log(
      `Applied ${summary.diffsApplied} daily diffs (state now at sequence ${current.sequenceNumber}); ` +
        `${summary.repairsFetched} geometry repairs fetched, ${summary.repairsSkippedGone} gone upstream, ` +
        `${summary.unresolvedRefs} refs unresolved; wrote ${summary.spots} spots ` +
        `(${summary.dogParks} dog parks, ${summary.bathingSpots} bathing spots) to ${options.outDatasetPath}`,
    );
    return summary;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- Tool plumbing, in the house style of seed-state.ts ----------

/** Runs a tool loudly: its output goes to ours, a non-zero exit throws. */
function run(command: string, args: string[]): void {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

/**
 * Runs check-refs and parses its answer. spawnSync rather than the run()
 * helper because exit 1 is how check-refs SAYS "references are missing"
 * (verified on 1.16.0) — the ids on stdout are the answer, not an error.
 * The trap: a hard failure (unreadable file) also exits 1, distinguishable
 * only by its empty stdout, so exit 1 with nothing parsed throws.
 */
function checkRefs(pbfPath: string): CheckRefsReport {
  console.log(`$ osmium check-refs -r --show-ids ${pbfPath}`);
  const result = spawnSync(
    "osmium",
    ["check-refs", "-r", "--show-ids", pbfPath],
    // 64 MiB of ids is far beyond any repairable state; overflowing throws,
    // which is the right answer to damage on that scale anyway.
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `osmium check-refs exited ${String(result.status)}: ${result.stderr}`,
    );
  }
  const report = parseCheckRefs(result.stdout);
  if (result.status === 1 && report.missingRefs === 0) {
    throw new Error(`osmium check-refs failed: ${result.stderr}`);
  }
  return report;
}

/** The exported FeatureCollection's features, or a throw (as in build-dataset.ts). */
function readFeatures(path: string): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const collection =
    typeof parsed === "object" && parsed !== null && "features" in parsed
      ? parsed
      : undefined;
  if (!collection || !Array.isArray(collection.features)) {
    throw new Error(
      `osmium export did not produce a FeatureCollection: ${path}`,
    );
  }
  const features: unknown[] = collection.features;
  return features;
}

// ---------- Network plumbing ----------

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, {
    // planet.osm.org 302s its replication files to S3; following is
    // fetch's default, spelled out because the job breaks without it.
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return await response.text();
}

async function fetchToFile(
  url: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  // The largest daily diff measured ~95 MB gzipped: comfortably one Buffer,
  // and a Buffer is simpler than piping a web stream into a file handle.
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

const pause = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((done) => setTimeout(done, ms));

// Wrapped rather than aliased, as in seed-state.ts: an unbound fetch throws.
const defaultFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- CLI plumbing, in the house style of seed-state.ts ----------

function parseFlags(
  argv: string[],
  allowed: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at];
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const value = argv[at + 1];
    if (!allowed.includes(flag) || value === undefined) {
      console.error(`Unrecognised or valueless argument: ${flag}\n\n${USAGE}`);
      process.exit(1);
    }
    values.set(flag.slice(2), value);
  }
  return values;
}

function requireFlags(
  values: Map<string, string>,
  names: readonly string[],
): string[] {
  const missing = names.filter((name) => !values.has(name));
  if (missing.length > 0) {
    console.error(
      `Missing required argument(s): ${missing
        .map((name) => `--${name}`)
        .join(", ")}\n\n${USAGE}`,
    );
    process.exit(1);
  }
  return names.map((name) => values.get(name) as string);
}

function positiveIntFlag(
  values: Map<string, string>,
  name: string,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(
      `--${name} must be a positive integer, got: ${raw}\n\n${USAGE}`,
    );
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), [
    "--state",
    "--meta",
    "--out-state",
    "--out-meta",
    "--out-dataset",
    "--max-diffs",
    "--max-repairs",
  ]);
  const [statePath, metaPath, outStatePath, outMetaPath, outDatasetPath] =
    requireFlags(flags, [
      "state",
      "meta",
      "out-state",
      "out-meta",
      "out-dataset",
    ]);
  await runUpdate({
    statePath,
    metaPath,
    outStatePath,
    outMetaPath,
    outDatasetPath,
    maxDiffs: positiveIntFlag(flags, "max-diffs"),
    maxRepairs: positiveIntFlag(flags, "max-repairs"),
  });
}

// Entry-point guard so the test file can import the pure functions without
// the CLI running (same pattern as seed-state.ts).
if (process.argv[1]?.endsWith("update-state.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
