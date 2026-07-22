import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FILTER_EXPRESSIONS, FILTER_VERSION } from "./filter";

/**
 * Seeds the global offline state file (docs/spec.md §5) from Geofabrik
 * region extracts. Two subcommands, run per region and then once:
 *
 *   filter-one  cuts one region extract down to the dog-relevant objects
 *               (filter.ts) and records the extract's replication timestamp
 *               next to it — the merge step needs the oldest.
 *
 *   merge       combines every filtered region into one state.osm.pbf and
 *               writes state.json: which daily planet diff to apply first,
 *               chosen so that replay starts a safe 24 h BEFORE the oldest
 *               region was cut. Replaying changes a region already contains
 *               is harmless — newer object versions win — but a deletion
 *               that fell between an old cut and the replay start would be
 *               missed forever, so the margin errs early.
 *
 * Deliberately thin, like build-dataset.ts: the decisions that can be wrong
 * — state.txt parsing, the sequence arithmetic, the timestamp selection —
 * are pure functions below, unit-tested in seed-state.test.ts. On any
 * failure the exception propagates, the process exits non-zero, and no
 * state.json exists, because writing it is the last thing that happens.
 */

const USAGE = [
  "Usage:",
  "  npx tsx pipeline/seed-state.ts filter-one --pbf <region.osm.pbf> --out <filtered.osm.pbf>",
  "  npx tsx pipeline/seed-state.ts merge --dir <filtered-dir> --out-state <state.osm.pbf> --out-meta <state.json>",
  "",
  "filter-one:",
  "  --pbf   a Geofabrik region extract (see pipeline/regions.json)",
  "  --out   where to write the filtered extract; the region's replication",
  "          timestamp lands alongside as <out>.timestamp.txt",
  "",
  "merge:",
  "  --dir        directory holding every filtered *.osm.pbf (+ timestamps)",
  "  --out-state  where to write the merged global state file",
  "  --out-meta   where to write the replication metadata (state.json)",
].join("\n");

/**
 * Sent on every HTTP request this tool makes. Non-browser clients must
 * identify themselves — overpass-api.de answers a blank User-Agent with an
 * HTML 406 page, and planet.osm.org's usage policy asks for the same
 * courtesy — so the rule here is blanket: no request goes out without one.
 */
export const USER_AGENT =
  "zoomies-data/0.1 (+https://github.com/ChrisSteinbach/zoomies)";

/** Where the daily planet diffs and their state files live. Redirects to S3. */
const DAILY_REPLICATION_BASE = "https://planet.osm.org/replication/day";

/** One replication day, which is also the seed's safety margin. */
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Replication state files, parsed ----------

export interface ReplicationState {
  sequenceNumber: number;
  timestamp: string;
}

/**
 * Parses an osmosis-format state.txt:
 *
 *   #Mon Jul 20 20:21:50 UTC 2026
 *   sequenceNumber=5061
 *   timestamp=2026-07-22T00\:00\:00Z
 *
 * Java-properties escaping is the trap: the colons in the timestamp arrive
 * as `\:` and must be unescaped, or every date parse downstream fails.
 */
export function parseReplicationState(text: string): ReplicationState {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    fields.set(
      trimmed.slice(0, eq),
      trimmed.slice(eq + 1).replaceAll("\\:", ":"),
    );
  }

  const sequenceText = fields.get("sequenceNumber");
  const sequenceNumber = Number(sequenceText);
  if (sequenceText === undefined || !Number.isInteger(sequenceNumber)) {
    throw new Error(`state.txt has no usable sequenceNumber: ${text}`);
  }
  const timestamp = fields.get("timestamp");
  if (timestamp === undefined || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`state.txt has no usable timestamp: ${text}`);
  }
  return { sequenceNumber, timestamp };
}

/**
 * A sequence number as the replication directory path osmosis derives from
 * it: nine digits, zero-padded, split into thirds — 5061 → "000/005/061".
 * The state file for a sequence then lives at `<path>.state.txt`.
 */
export function sequenceStatePath(sequenceNumber: number): string {
  if (
    !Number.isInteger(sequenceNumber) ||
    sequenceNumber < 0 ||
    sequenceNumber > 999_999_999
  ) {
    throw new Error(`Not a replication sequence number: ${sequenceNumber}`);
  }
  const padded = String(sequenceNumber).padStart(9, "0");
  return `${padded.slice(0, 3)}/${padded.slice(3, 6)}/${padded.slice(6)}`;
}

/**
 * The first guess at which daily sequence covers a safety timestamp: walk
 * back one sequence per elapsed day, then one more so the error is on the
 * early side. It is only a guess — replication days are not exactly 24 h
 * apart, and runs have been skipped — which is why
 * {@link resolveDailySequence} verifies against the real state files and
 * walks from here. Clamped to [1, current], since the walk cannot start
 * outside the history that exists.
 */
export function candidateSequence(
  current: ReplicationState,
  safetyTimestamp: string,
): number {
  const currentMs = parseTimestampMs(current.timestamp, "current state");
  const safetyMs = parseTimestampMs(safetyTimestamp, "safety timestamp");
  const daysBehind = Math.ceil((currentMs - safetyMs) / DAY_MS);
  const candidate = current.sequenceNumber - daysBehind - 1;
  return Math.min(Math.max(candidate, 1), current.sequenceNumber);
}

function parseTimestampMs(timestamp: string, what: string): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    throw new Error(`${what} is not a parseable timestamp: ${timestamp}`);
  }
  return ms;
}

/**
 * The daily replication sequence to seed from: the newest one whose state
 * timestamp is ≤ the safety timestamp — equivalently, seq with
 * ts(seq) ≤ safety < ts(seq+1) — so that applying diffs seq+1, seq+2, …
 * replays everything that could postdate any region cut.
 *
 * Starts from {@link candidateSequence}'s guess and walks ±1, reading each
 * sequence's real state file, because the guess's day arithmetic is only
 * approximate. The walk is bounded: a history irregular enough to defeat
 * the bound deserves a loud failure, not an infinite crawl over
 * planet.osm.org.
 */
const MAX_SEQUENCE_WALK = 60;

export async function resolveDailySequence(
  safetyTimestamp: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<number> {
  const head = parseReplicationState(
    await fetchText(`${DAILY_REPLICATION_BASE}/state.txt`, fetchImpl),
  );
  const safetyMs = parseTimestampMs(safetyTimestamp, "safety timestamp");

  // Regions newer than the replication head cannot happen from a coherent
  // mirror, but if it does, the head itself is the only safe start.
  if (safetyMs >= parseTimestampMs(head.timestamp, "head state")) {
    return head.sequenceNumber;
  }

  const cache = new Map<number, number>();
  const timestampMsOf = async (sequence: number): Promise<number> => {
    const cached = cache.get(sequence);
    if (cached !== undefined) return cached;
    const state = parseReplicationState(
      await fetchText(
        `${DAILY_REPLICATION_BASE}/${sequenceStatePath(sequence)}.state.txt`,
        fetchImpl,
      ),
    );
    const ms = parseTimestampMs(state.timestamp, `state ${sequence}`);
    cache.set(sequence, ms);
    return ms;
  };

  let candidate = candidateSequence(head, safetyTimestamp);
  for (let step = 0; step < MAX_SEQUENCE_WALK; step += 1) {
    if ((await timestampMsOf(candidate)) > safetyMs) {
      if (candidate <= 1) {
        throw new Error(
          `Safety timestamp ${safetyTimestamp} predates the daily replication history`,
        );
      }
      candidate -= 1;
      continue;
    }
    if (candidate === head.sequenceNumber) return candidate;
    if ((await timestampMsOf(candidate + 1)) <= safetyMs) {
      candidate += 1;
      continue;
    }
    return candidate;
  }
  throw new Error(
    `Could not bracket ${safetyTimestamp} within ${MAX_SEQUENCE_WALK} state files — is the replication history coherent?`,
  );
}

// ---------- The state metadata ----------

export interface SeededFromEntry {
  /** The filtered file's name within the merge directory. */
  file: string;
  /** The source extract's osmosis_replication_timestamp. */
  timestamp: string;
}

export interface SeedStateMeta {
  schema: 1;
  filterVersion: number;
  sequenceNumber: number;
  timestamp: string;
  seededFrom: SeededFromEntry[];
}

/**
 * The seed's replay-from timestamp: the OLDEST region timestamp minus 24
 * hours. The margin is asymmetric on purpose — replaying already-seen
 * changes is harmless because newer object versions win the merge, while a
 * deletion that slipped between a region's cut and the replay start would
 * survive as a ghost forever.
 */
export function safetySeedTimestamp(
  seededFrom: readonly SeededFromEntry[],
): string {
  if (seededFrom.length === 0) {
    throw new Error(
      "No seeded-from entries — nothing to compute a timestamp from",
    );
  }
  const oldestMs = Math.min(
    ...seededFrom.map((entry) => parseTimestampMs(entry.timestamp, entry.file)),
  );
  return new Date(oldestMs - DAY_MS).toISOString();
}

/** The state.json envelope, exactly as the daily update job will read it. */
export function buildStateMeta(
  seededFrom: readonly SeededFromEntry[],
  sequenceNumber: number,
): SeedStateMeta {
  return {
    schema: 1,
    filterVersion: FILTER_VERSION,
    sequenceNumber,
    timestamp: safetySeedTimestamp(seededFrom),
    seededFrom: [...seededFrom],
  };
}

// ---------- Merging filtered regions ----------

/**
 * Merges filtered region extracts into one single-version snapshot,
 * newest version of every object winning.
 *
 * NOT `osmium merge`: Geofabrik regions overlap at their borders and are
 * cut at slightly different times, so the same object can appear in two
 * inputs at different versions, and the osmium-merge(1) man page is
 * explicit that all versions would then appear in the output — "Do not use
 * this command to merge non-history files with data from different points
 * in time. It will not work correctly." Verified empirically (osmium
 * 1.16.0): two files sharing a node at v1 and v2 merge into a file
 * carrying both versions.
 *
 * The chain that does work, also verified empirically and pinned by the
 * integration test in seed-state.test.ts:
 *
 *   1. `osmium cat` concatenates the snapshots into one change file
 *      (data → .osc conversion wraps objects in create/modify, which
 *      apply-changes treats alike);
 *   2. `osmium merge-changes --simplify` sorts by type, id, version,
 *      timestamp and keeps only the LAST version of each object — the
 *      newest-wins collapse. Input order is irrelevant because the sort
 *      looks at versions, not file order: the man page's oldest-to-newest
 *      ordering caveat concerns change files where one version+timestamp
 *      can hide different contents, and two Geofabrik cuts of the same
 *      object at the same version are the same bytes;
 *   3. `osmium apply-changes` onto an empty base materializes the change
 *      file as a normal data file — sorted by type and id, single version
 *      per object (fileinfo: "Objects ordered: yes; Multiple versions:
 *      no") — a valid base for the daily `osmium apply-changes` updates.
 */
export function mergeFilteredPbfs(inputs: string[], outState: string): void {
  if (inputs.length === 0) {
    throw new Error("No filtered .osm.pbf files to merge");
  }
  const tmp = mkdtempSync(join(tmpdir(), "zoomies-seed-"));
  try {
    const combinedOsc = join(tmp, "combined.osc.gz");
    const simplifiedOsc = join(tmp, "simplified.osc.gz");
    const emptyOsm = join(tmp, "empty.osm");

    run("osmium", ["cat", ...inputs, "-o", combinedOsc, "--overwrite"]);
    run("osmium", [
      "merge-changes",
      "--simplify",
      combinedOsc,
      "-o",
      simplifiedOsc,
      "--overwrite",
    ]);
    writeFileSync(
      emptyOsm,
      `<?xml version='1.0' encoding='UTF-8'?>\n<osm version="0.6" generator="zoomies-seed"/>\n`,
    );
    run("osmium", [
      "apply-changes",
      emptyOsm,
      simplifiedOsc,
      "-o",
      outState,
      "--overwrite",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- The two subcommands ----------

/**
 * The extract's osmosis_replication_timestamp, from `osmium fileinfo -j`.
 * A region file without one cannot participate in seeding — the merge step
 * derives the replay point from the oldest timestamp — so its absence is an
 * error, not a shrug.
 */
function replicationTimestampOf(pbfPath: string): string {
  const stdout = execFileSync("osmium", ["fileinfo", "-j", pbfPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const info: unknown = JSON.parse(stdout);
  const header = isRecord(info) ? info.header : undefined;
  const option = isRecord(header) ? header.option : undefined;
  const timestamp = isRecord(option)
    ? option.osmosis_replication_timestamp
    : undefined;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(
      `${pbfPath} carries no osmosis_replication_timestamp — cannot seed from an extract of unknown age`,
    );
  }
  return timestamp;
}

function filterOne(args: { pbf: string; out: string }): void {
  // Read the timestamp before the expensive filter run: an extract the
  // merge step cannot date should fail in seconds, not after minutes.
  const timestamp = replicationTimestampOf(args.pbf);

  // Referenced nodes are kept by default, and must be: the eventual export
  // needs them to build way geometry (same rationale as build-dataset.ts).
  run("osmium", [
    "tags-filter",
    args.pbf,
    ...FILTER_EXPRESSIONS,
    "-o",
    args.out,
    "--overwrite",
  ]);

  writeFileSync(`${args.out}.timestamp.txt`, `${timestamp}\n`);
  console.log(`osmosis_replication_timestamp: ${timestamp}`);
}

async function merge(
  args: { dir: string; outState: string; outMeta: string },
  fetchImpl: typeof fetch = defaultFetch,
): Promise<void> {
  const files = readdirSync(args.dir)
    .filter((file) => file.endsWith(".osm.pbf"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No *.osm.pbf files in ${args.dir}`);
  }

  const seededFrom: SeededFromEntry[] = files.map((file) => {
    const timestampPath = join(args.dir, `${file}.timestamp.txt`);
    if (!existsSync(timestampPath)) {
      throw new Error(
        `${file} has no ${file}.timestamp.txt beside it — was it filtered by \`seed-state.ts filter-one\`?`,
      );
    }
    const timestamp = readFileSync(timestampPath, "utf8").trim();
    parseTimestampMs(timestamp, timestampPath);
    return { file, timestamp };
  });

  // Resolve the replay sequence before the heavy merge: a network failure
  // should cost seconds. The metadata is still WRITTEN last — a state file
  // without metadata is unusable noise, but metadata without a state file
  // would be a lie the update job acts on.
  const sequenceNumber = await resolveDailySequence(
    safetySeedTimestamp(seededFrom),
    fetchImpl,
  );

  mergeFilteredPbfs(
    files.map((file) => join(args.dir, file)),
    args.outState,
  );

  const meta = buildStateMeta(seededFrom, sequenceNumber);
  writeFileSync(args.outMeta, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(
    `Merged ${files.length} regions into ${args.outState}; ` +
      `replay starts at daily sequence ${meta.sequenceNumber} (${meta.timestamp})`,
  );
}

// ---------- Plumbing, in the house style of build-dataset.ts ----------

/** Runs a tool loudly: its output goes to ours, a non-zero exit throws. */
function run(command: string, args: string[]): void {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, {
    // planet.osm.org 302s its replication files to S3; following is
    // fetch's default, spelled out because the seed breaks without it.
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return await response.text();
}

// Wrapped rather than aliased, as in overpass.ts: an unbound fetch throws.
const defaultFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return;
  }
  if (subcommand === "filter-one") {
    const flags = parseFlags(rest, ["--pbf", "--out"]);
    const [pbf, out] = requireFlags(flags, ["pbf", "out"]);
    filterOne({ pbf, out });
    return;
  }
  if (subcommand === "merge") {
    const flags = parseFlags(rest, ["--dir", "--out-state", "--out-meta"]);
    const [dir, outState, outMeta] = requireFlags(flags, [
      "dir",
      "out-state",
      "out-meta",
    ]);
    await merge({ dir, outState, outMeta });
    return;
  }

  console.error(
    `${subcommand === undefined ? "A subcommand is required" : `Unknown subcommand: ${subcommand}`}\n\n${USAGE}`,
  );
  process.exit(1);
}

// Entry-point guard so the test file can import the pure functions without
// the CLI running (build-dataset.ts has no importers, so it needs none).
if (process.argv[1]?.endsWith("seed-state.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
