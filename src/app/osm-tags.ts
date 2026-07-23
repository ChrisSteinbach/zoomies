import { parseDogConditional } from "./dog-conditional";
import type { DogSpot, Provenance, SeasonalRule, SpotTags } from "./types";

/**
 * What the app's layers mean, in OSM's vocabulary.
 *
 * Two data paths answer the same two questions: the live Overpass provider,
 * which encodes these rules as OverpassQL and lets the server apply them, and
 * the offline dataset pipeline, which applies them itself to a Geofabrik
 * extract (docs/spec.md §5, Option B). If each path carried its own copy of
 * the rules, they would drift, and the app would give different answers
 * depending on which source happened to serve a query — the quiet kind of
 * wrong the seam exists to prevent. So the vocabulary lives here once: the
 * query builder derives its clauses from these constants, and the converter
 * calls these predicates, and neither can disagree with the other.
 *
 * Raw OSM tag bags (`Record<string, unknown>`) appear in the signatures
 * deliberately: this module is the boundary where OSM's vocabulary is read.
 * What leaves is domain-shaped — {@link DogSpot}s and nothing else.
 */

/** The tag that makes a feature a dog park (docs/spec.md §4.2). */
export const DOG_PARK_TAG = { key: "leisure", value: "dog_park" } as const;

/**
 * The bathing features worth asking about dogs (docs/spec.md §4.3): a
 * natural-water bathing spot, a beach, or designated swimming water. A `dog`
 * tag on anything else — a park bench, a café — is not a bathing spot.
 */
export const BATHING_FEATURE_TAGS = [
  { key: "leisure", value: "bathing_place" },
  { key: "natural", value: "beach" },
  { key: "leisure", value: "swimming_area" },
] as const;

/**
 * The `dog` values that make a tagged bathing feature part of the answer.
 *
 * Exactly these two: `dog=designated` (the place is for dogs) and `dog=yes`
 * (dogs are allowed). Weaker values — `leashed`, `unleashed` — do not qualify
 * a feature on their own; they only grade one the name fallback already
 * found.
 */
export const DOG_ALLOWED_VALUES = ["yes", "designated"] as const;

/**
 * The word the Sweden-specific name fallback looks for (docs/spec.md §4.3):
 * many hundbad are mapped as generic features with "hundbad" in the name and
 * no `dog=*` tag at all. Matched case-insensitively, anywhere in the name.
 */
export const HUNDBAD_NAME_SUBSTRING = "hundbad";

/**
 * The tag families the name fallback is allowed to search.
 *
 * Not in the spec's version of the query, and load-bearing: an unbounded
 * name match runs over every named object — every street, shop and bus stop
 * — and, measured on 2026-07-21, that times out inside Overpass's own
 * 25-second budget at the 25 km radius around central Stockholm. Since the
 * widest ring is exactly where a thin layer ends up, the unbounded clause
 * would turn "no bathing spots within 25 km" into a permanent error in the
 * one city the spec requires to work (§2.1).
 *
 * Requiring an indexed tag family first keeps the match to feature-shaped
 * objects. The cost of the bound: a hundbad whose element carries a name and
 * none of these families is out of reach — and such an element would also
 * give us nothing to render or grade, so the recall given up is places the
 * app could only have pointed at, not described.
 *
 * The offline converter applies the same bound, not for speed — a local
 * scan is free — but so both sources answer alike.
 */
export const NAMED_FEATURE_FAMILIES = [
  "natural",
  "leisure",
  "amenity",
  "man_made",
  "place",
] as const;

/** Whether these tags make the feature a dog park. */
export function isDogPark(tags: Record<string, unknown>): boolean {
  return tags[DOG_PARK_TAG.key] === DOG_PARK_TAG.value;
}

/**
 * Whether these tags put the feature in the bathing answer at all.
 *
 * The union of docs/spec.md §4.3: a tagged bathing feature that says dogs
 * are allowed, or any named-feature family whose name contains "hundbad".
 * Candidacy only — {@link asBathingSpot} still grades the claim and drops
 * features whose tags deny dogs.
 */
export function isBathingCandidate(tags: Record<string, unknown>): boolean {
  const allowsDogs = DOG_ALLOWED_VALUES.some((value) => tags.dog === value);
  const isBathingFeature = BATHING_FEATURE_TAGS.some(
    ({ key, value }) => tags[key] === value,
  );
  if (isBathingFeature && allowsDogs) return true;

  return hasNamedFeatureFamily(tags) && nameContainsHundbad(tags);
}

function hasNamedFeatureFamily(tags: Record<string, unknown>): boolean {
  return NAMED_FEATURE_FAMILIES.some((family) => family in tags);
}

function nameContainsHundbad(tags: Record<string, unknown>): boolean {
  const name = tags.name;
  return (
    typeof name === "string" &&
    name.toLowerCase().includes(HUNDBAD_NAME_SUBSTRING)
  );
}

/**
 * The fields shared by both layers: identity, name, position, display tags.
 * What the layers add on top is the *claim* made about dogs — kind,
 * provenance, seasonal rules.
 */
export type SpotSkeleton = Omit<DogSpot, "kind" | "provenance" | "seasonal">;

/**
 * A skeleton as the dog park it was matched as.
 *
 * Unconditional, because candidacy is the caller's business: the live query
 * matched `leisure=dog_park` server-side, and the offline converter checks
 * {@link isDogPark} itself. Everything that arrives here *is* the statement
 * that the place is for dogs.
 *
 * No `seasonal`, deliberately: `dog:conditional` describes a beach ban
 * season, and a dog park is not seasonally closed to dogs. Reading the tag
 * here would invent a caveat the park layer has no business making.
 */
export function asDogPark(skeleton: SpotSkeleton): DogSpot {
  return {
    ...skeleton,
    kind: "dog_park",
    provenance: "designated",
  };
}

/**
 * A skeleton as the bathing spot its tags claim it is — or nothing, when
 * they deny dogs, in which case the feature is dropped.
 *
 * The claim is read from the element's own tags rather than from which
 * pattern matched it, because Overpass does not say which one did — and so
 * the offline converter must not either.
 */
export function asBathingSpot(
  skeleton: SpotSkeleton,
  tags: Record<string, unknown>,
): DogSpot | undefined {
  const provenance = bathingProvenance(tags);
  if (!provenance) return undefined;

  const seasonal = seasonalRule(tags);

  return {
    ...skeleton,
    kind: "bathing_spot",
    provenance,
    ...(seasonal ? { seasonal } : {}),
  };
}

/**
 * How strong a claim this feature makes about dogs — or nothing at all, when
 * it says dogs are not welcome.
 *
 * `dog=no` is the exclusion that matters: such a feature can only have
 * reached us through the name fallback, and a beach called "Hundbadet" that
 * has since been tagged as banning dogs is precisely the confidently wrong
 * pin the spec forbids (§3). Dropping it costs a result; showing it costs
 * someone a wasted trip, or a fine.
 */
function bathingProvenance(
  tags: Record<string, unknown>,
): Provenance | undefined {
  const dog = tags.dog;

  // Specifically intended for dogs: a dog beach (§4.3).
  if (dog === "designated") return "designated";
  // Dogs are allowed, though the place is not for them. `leashed` and
  // `unleashed` can only arrive through the name fallback — the tagged
  // patterns require {@link DOG_ALLOWED_VALUES} — but they still say dogs
  // belong here.
  if (dog === "yes" || dog === "leashed" || dog === "unleashed") {
    return "permitted";
  }
  if (dog === "no") return undefined;

  // No `dog` tag, or a value nobody has thought about: the word in the name
  // is the only reason this feature is in the answer, and the UI must say so.
  return "name-match";
}

/**
 * The seasonal ban OSM records for this feature, when it records one.
 *
 * Absent `dog:conditional` leaves the field off entirely rather than
 * asserting "no restriction" — the UI's verify-signage caveat is what covers
 * that case (§4.5.3), and a value this app cannot read still comes back as
 * `unparsed` so the caveat sharpens rather than disappears.
 */
function seasonalRule(tags: Record<string, unknown>): SeasonalRule | undefined {
  const conditional = tags["dog:conditional"];
  if (typeof conditional !== "string" || conditional === "") return undefined;
  return parseDogConditional(conditional);
}

/**
 * Fold a dropped element's tags into the one that survives a collapse.
 *
 * When two OSM elements are collapsed into one row (see
 * `double-mapping.ts`), the kept element's tags win wherever it speaks, and
 * the dropped element's tag is adopted only where the kept one is silent.
 * Two alternatives were considered: (a) keep only the kept element's tags —
 * never invents a claim, but may drop a surveyed one; (b) adopt the dropped
 * element's tag only where the kept spot is silent — turns two half-surveys
 * into one row without contradicting either surveyor. We chose (b): it is
 * more honest to the surveyors' work, and absence still means "nobody said"
 * (the `describeTags` contract in spot-list.ts), because `??` fills only
 * silence — a surveyed `false` on the kept side is preserved (`false ??
 * true` is `false`).
 *
 * Returns a new object; never mutates either input.
 */
export function adoptSilentTags(kept: SpotTags, dropped: SpotTags): SpotTags {
  return {
    leashRequired: kept.leashRequired ?? dropped.leashRequired,
    fenced: kept.fenced ?? dropped.fenced,
    lit: kept.lit ?? dropped.lit,
    surface: kept.surface ?? dropped.surface,
  };
}

/**
 * The OSM tags worth showing, translated.
 *
 * A field is set only when OSM actually says something. Absent means unknown,
 * and must never be flattened into "no" (see {@link SpotTags}).
 */
export function toSpotTags(tags: Record<string, unknown>): SpotTags {
  const spotTags: SpotTags = {};

  const leashRequired = readLeashRequired(tags);
  if (leashRequired !== undefined) spotTags.leashRequired = leashRequired;

  const fenced = readFenced(tags);
  if (fenced !== undefined) spotTags.fenced = fenced;

  const lit = readLit(tags);
  if (lit !== undefined) spotTags.lit = lit;

  // Passed through verbatim: OSM's surface vocabulary is open, and an enum
  // here would silently drop values we have not thought of.
  const surface = tags.surface;
  if (typeof surface === "string" && surface !== "") spotTags.surface = surface;

  return spotTags;
}

/**
 * Whether dogs must be kept on a lead.
 *
 * OSM's `dog` tag answers two different questions: whether dogs may enter
 * (`yes`, `no`, `designated`) and what the rules demand once they are in
 * (`leashed`, `unleashed`). Only the two leash values answer this one —
 * `dog=designated` welcomes dogs and says nothing about leads, so it
 * leaves the answer unknown rather than implying one.
 *
 * And it is only the rule as mapped: Swedish leash seasons (1 March –
 * 20 August in many municipalities) can override an `unleashed` tag for
 * months at a time, which is what the verify-signage stance covers
 * (docs/spec.md §4.5.3).
 */
function readLeashRequired(tags: Record<string, unknown>): boolean | undefined {
  if (tags.dog === "leashed") return true;
  if (tags.dog === "unleashed") return false;
  return undefined;
}

/**
 * Whether the park is enclosed.
 *
 * Mappers express this two ways: `fenced=yes|no` on the park, or
 * `barrier=fence` on its outline. `fenced` wins where both appear, being the
 * direct statement about the park rather than about one of its edges.
 * Anything else — `fenced=partial`, `barrier=hedge`, a bare `fence_type` —
 * leaves the answer unknown.
 */
function readFenced(tags: Record<string, unknown>): boolean | undefined {
  if (tags.fenced === "yes") return true;
  if (tags.fenced === "no") return false;
  if (tags.barrier === "fence") return true;
  if (tags.barrier === "no") return false;
  return undefined;
}

/**
 * Whether the park is lit after dark — in a Swedish winter, the difference
 * between usable and not.
 *
 * `lit` is not a boolean tag: `lit=24/7`, `lit=sunset-sunrise` and
 * `lit=limited` are all in use and all mean there are lamps. Only `lit=no`
 * denies it, so every other value is read as lit.
 */
function readLit(tags: Record<string, unknown>): boolean | undefined {
  const lit = tags.lit;
  if (typeof lit !== "string" || lit === "") return undefined;
  return lit !== "no";
}
