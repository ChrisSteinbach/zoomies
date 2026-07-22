import { DOG_PARK_TAG, HUNDBAD_NAME_SUBSTRING } from "../src/app/osm-tags";

/**
 * The one home of the `osmium tags-filter` preselection, shared by every
 * pipeline entry point that runs osmium — build-dataset.ts (one-shot regional
 * builds), seed-state.ts (the global seed) and the daily update job. It lives
 * apart from all of them so there is exactly one answer to "what does the
 * pipeline keep", and a filter change cannot land in one path but not
 * another.
 */

/**
 * Version stamp for {@link FILTER_EXPRESSIONS}, recorded in the seed state's
 * metadata. Any change to the expressions — however small, however
 * provably-equivalent — MUST bump this number: a state file filtered under
 * the old expressions can only be updated with diffs filtered under the same
 * ones, so a mismatch between this constant and a state file's recorded
 * filterVersion means the state must be re-seeded, not updated. The stamp is
 * how the update job can tell.
 */
export const FILTER_VERSION = 2;

/**
 * What `osmium tags-filter` keeps, derived from the shared vocabulary in
 * osm-tags.ts so this preselection cannot drift from the converter that
 * grades it. It is a SUPERSET on purpose: every expression may keep more
 * than the app wants — dog=no benches, dog-tagged cafés — and the converter
 * applies the exact rules (isDogPark, isBathingCandidate) to what survives.
 *
 * The `dog` key expression is where the superset earns its keep. Every
 * tagged bathing pattern in osm-tags.ts — each BATHING_FEATURE_TAGS entry —
 * qualifies a feature only when it ALSO carries `dog` set to one of
 * DOG_ALLOWED_VALUES (isBathingCandidate), so selecting on the `dog` key
 * alone, any value, keeps everything those patterns can ever accept. What it
 * drops, relative to filtering on the bathing tags themselves, is the
 * roughly one million beaches, bathing places and swimming areas that carry
 * no `dog` tag at all — objects the converter would have rejected anyway,
 * but which at planet scale dominate the filtered file. Features reachable
 * only through the name fallback are the name globs' job, below.
 *
 * The two name globs are where the superset is subtle. osmium's value
 * matching is case-sensitive while the app's name rule is
 * case-insensitive, so the leading letter — the one whose case flips
 * between "hundbad" and "Hundbad" — is dropped from the pattern, and a
 * second all-caps glob catches "HUNDBAD". A theoretical mixed-case
 * "HuNdBaD" is lost at this stage: the accepted cost, since no such name
 * has been seen in the wild and the alternative is keeping every named
 * object on the planet.
 */
export const FILTER_EXPRESSIONS: readonly string[] = [
  `nwr/${DOG_PARK_TAG.key}=${DOG_PARK_TAG.value}`,
  "nwr/dog",
  `nwr/name=*${HUNDBAD_NAME_SUBSTRING.slice(1)}*`,
  `nwr/name=*${HUNDBAD_NAME_SUBSTRING.slice(1).toUpperCase()}*`,
];
