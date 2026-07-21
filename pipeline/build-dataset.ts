import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BATHING_FEATURE_TAGS,
  DOG_PARK_TAG,
  HUNDBAD_NAME_SUBSTRING,
} from "../src/app/osm-tags";
import { SWEDEN_REGION, assertDatasetSane, buildDataset } from "./convert";

/**
 * The offline pipeline's orchestrator (docs/spec.md §5, Option B):
 *
 *   osmium tags-filter → osmium export → convert.ts → one JSON file
 *
 * Deliberately thin: every decision that can be wrong lives in convert.ts,
 * where it is unit-tested. This file only runs tools, moves bytes and
 * stamps the clock. On any failure — a tool exiting non-zero, output that
 * does not parse, a sanity gate tripping — the exception propagates, the
 * process exits non-zero and no output file exists, because writing it is
 * the last thing that happens. A broken build cannot publish.
 *
 * Run as `npm run data:build -- --pbf … --poly … --out …`, or see USAGE.
 * Needs osmium-tool on PATH (a system package; CI installs it with apt).
 */

/**
 * What `osmium tags-filter` keeps, derived from the shared vocabulary in
 * osm-tags.ts so this preselection cannot drift from the converter that
 * grades it. It is a SUPERSET on purpose: every expression may keep more
 * than the app wants — untagged beaches, dog=no bathing places — and the
 * converter applies the exact rules (isDogPark, isBathingCandidate) to
 * what survives.
 *
 * The two name globs are where the superset is subtle. osmium's value
 * matching is case-sensitive while the app's name rule is
 * case-insensitive, so the leading letter — the one whose case flips
 * between "hundbad" and "Hundbad" — is dropped from the pattern, and a
 * second all-caps glob catches "HUNDBAD". A theoretical mixed-case
 * "HuNdBaD" is lost at this stage: the accepted cost, since no such name
 * has been seen in the wild and the alternative is keeping every named
 * object in Sweden.
 */
const FILTER_EXPRESSIONS = [
  `nwr/${DOG_PARK_TAG.key}=${DOG_PARK_TAG.value}`,
  ...BATHING_FEATURE_TAGS.map(({ key, value }) => `nwr/${key}=${value}`),
  `nwr/name=*${HUNDBAD_NAME_SUBSTRING.slice(1)}*`,
  `nwr/name=*${HUNDBAD_NAME_SUBSTRING.slice(1).toUpperCase()}*`,
];

const USAGE = [
  "Usage: npx tsx pipeline/build-dataset.ts --pbf <extract.osm.pbf> --poly <boundary.poly> --out <dataset.json> [--region <name>]",
  "",
  "  --pbf     Geofabrik extract to cut the spots from",
  "  --poly    the region's .poly boundary (becomes the dataset's coverage)",
  "  --out     where to write the dataset JSON",
  `  --region  region name stamped into the dataset (default: ${SWEDEN_REGION})`,
].join("\n");

interface CliArgs {
  pbf: string;
  poly: string;
  region: string;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at];
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const value = argv[at + 1];
    if (
      !["--pbf", "--poly", "--region", "--out"].includes(flag) ||
      value === undefined
    ) {
      console.error(`Unrecognised or valueless argument: ${flag}\n\n${USAGE}`);
      process.exit(1);
    }
    values.set(flag.slice(2), value);
  }

  const pbf = values.get("pbf");
  const poly = values.get("poly");
  const out = values.get("out");
  if (pbf === undefined || poly === undefined || out === undefined) {
    console.error(`--pbf, --poly and --out are all required\n\n${USAGE}`);
    process.exit(1);
  }
  return { pbf, poly, out, region: values.get("region") ?? SWEDEN_REGION };
}

/** Runs a tool loudly: its output goes to ours, a non-zero exit throws. */
function run(command: string, args: string[]): void {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

/** The exported FeatureCollection's features, or a throw. */
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tmp = mkdtempSync(join(tmpdir(), "zoomies-dataset-"));
  try {
    const filteredPbf = join(tmp, "filtered.osm.pbf");
    const filteredGeojson = join(tmp, "filtered.geojson");

    // Referenced nodes are kept by default, and must be: osmium export
    // needs them to build way geometry. Do not add --omit-referenced.
    run("osmium", [
      "tags-filter",
      args.pbf,
      ...FILTER_EXPRESSIONS,
      "-o",
      filteredPbf,
      "--overwrite",
    ]);

    // type_id ids ("n123") are how the converter recovers each feature's
    // OSM identity; without them nothing can be emitted.
    run("osmium", [
      "export",
      filteredPbf,
      "-o",
      filteredGeojson,
      "--overwrite",
      "--add-unique-id=type_id",
    ]);

    const dataset = buildDataset({
      features: readFeatures(filteredGeojson),
      polyText: readFileSync(args.poly, "utf8"),
      region: args.region,
      generatedAt: new Date().toISOString(),
    });
    assertDatasetSane(dataset, args.region);

    // Compact on purpose: the file ships over the network on first open.
    writeFileSync(args.out, JSON.stringify(dataset));

    const parks = dataset.spots.filter((s) => s.kind === "dog_park").length;
    const bathing = dataset.spots.length - parks;
    console.log(
      `Wrote ${dataset.spots.length} spots (${parks} dog parks, ` +
        `${bathing} bathing spots) for ${args.region} to ${args.out}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
