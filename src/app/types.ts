/** A geographic position. The app's only position type. */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * What kind of place a result is.
 *
 * Phase 1 produces only dog parks. Bathing spots arrive in phase 2 and are
 * a materially weaker dataset — see docs/spec.md §4.3.
 */
export type DogSpotKind = "dog_park" | "bathing_spot";

/**
 * How we know dogs belong here, strongest first.
 *
 * The distinction is not pedantry: OSM records existence, not current
 * legality (docs/spec.md §4.5.3). A place tagged specifically for dogs is a
 * different claim from a place that merely tolerates them, which is a
 * different claim again from a place whose label happens to contain a word.
 * The UI must not flatten all three into one confident pin.
 */
export type Provenance =
  /** The feature's own tags say it is for dogs: `leisure=dog_park`, or a
   *  bathing feature tagged `dog=designated`. */
  | "designated"
  /** Dogs are allowed but the place is not for them: `dog=yes`. */
  | "permitted"
  /** Matched only because "hundbad" appears in the name, with no `dog=*`
   *  tag at all. The Sweden-specific fallback of docs/spec.md §4.3 — it
   *  finds real places that nothing else finds, and also false positives. */
  | "name-match";

/**
 * Tags worth showing on a result.
 *
 * Every field is optional, and an absent field means *OSM does not say* —
 * never "no". Rendering absence as a negative would be exactly the
 * confidently-wrong answer the spec forbids (docs/spec.md §3).
 */
export interface SpotTags {
  /** Enclosed, so a dog can be let off the lead without leaving. */
  fenced?: boolean;
  /** Lit after dark — the difference between usable and not, in a Swedish
   *  winter. */
  lit?: boolean;
  /** Raw OSM `surface` value, e.g. "grass", "sand", "dirt". Free-form by
   *  design: OSM's vocabulary is open, and inventing an enum here would
   *  silently drop values we have not thought of. */
  surface?: string;
}

/**
 * One place a dog can go, as the app understands it.
 *
 * Deliberately *not* an Overpass element: this type is the seam that keeps
 * the data source replaceable (see PlaceProvider). It carries no distance,
 * because distance depends on where the user is standing and changes as
 * they walk — it is computed at render time from the current position.
 */
export interface DogSpot {
  /** Stable identity, `"<osm-type>/<osm-id>"`, e.g. `"way/58082448"`.
   *  Unique across element types, which plain OSM ids are not. */
  id: string;
  kind: DogSpotKind;
  /** OSM `name`, when the feature has one. Many dog parks genuinely have
   *  none, so this is absent rather than a fabricated placeholder — the UI
   *  decides what to show instead. */
  name?: string;
  lat: number;
  lon: number;
  tags: SpotTags;
  provenance: Provenance;
}
