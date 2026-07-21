// The result list: every spot we found, nearest first (docs/spec.md §7.3).
//
// A view and nothing else. It is handed the spots, where the user is, and
// which row is selected, and it renders them. It owns no state, runs no
// transitions and fetches nothing; everything it has to say goes out through
// the callbacks, so the composition root remains the only place that knows
// what selecting a row or asking for directions actually *does*.
//
// Since phase 2 the list holds both layers, and the two are not equally well
// known. A dog park is a dog park: `leisure=dog_park` says so, and the row can
// simply name it. A bathing spot is a claim of several different strengths
// (docs/spec.md §4.3) about a place whose legality changes with the season
// (§4.5.3) — so every bathing row says which claim it is making and what the
// season does to it, and does so in a way a hurried reader cannot mistake for
// a verified dog beach.

import type {
  DogSpot,
  DogSpotKind,
  LatLon,
  Provenance,
  SpotTags,
} from "./types";
import { haversineMeters } from "./geo";
import { formatDistance, formatMonthDay } from "./format";
import { isBannedOn } from "./dog-conditional";

/**
 * What we show when OSM has no name for a spot.
 *
 * Plenty of real dog parks and bathing spots are genuinely unnamed, so this is
 * a label for a known place rather than an apology for missing data
 * (docs/spec.md §7.3). It names the kind because the list holds both: a row
 * reading just "Unnamed" would be the one row on screen that does not say what
 * it is.
 */
const UNNAMED: Record<DogSpotKind, string> = {
  dog_park: "Unnamed dog park",
  bathing_spot: "Unnamed bathing spot",
};

/** The badge beside a bathing spot's name — the at-a-glance layer marker,
 *  coloured to match its pin on the map. */
const BATHING_BADGE = "Bathing";

/**
 * What the data actually claims about dogs at a bathing spot, in one line.
 *
 * Three lines for three different claims, because they *are* different: a
 * place mapped specifically for dogs, a place that merely allows them, and a
 * place that is in the results solely because the word "hundbad" appears in
 * its name (docs/spec.md §4.3). Flattening them into one confident caption is
 * exactly what {@link Provenance} exists to prevent — the name-match line has
 * to read as the guess it is, or a false positive looks like a dog beach.
 *
 * Dog parks get no such line. `leisure=dog_park` *is* the designation, so a
 * caption saying so under every park would be noise the eye soon learns to
 * skip past — which is precisely the habit the bathing lines cannot afford.
 */
const PROVENANCE_LABELS: Record<Provenance, string> = {
  designated: "Dog bathing area",
  permitted: "Dogs allowed",
  "name-match": "Unverified — matched by name",
};

/**
 * The caption for a bathing spot OSM says nothing seasonal about.
 *
 * The spec's default for *every* bathing spot (docs/spec.md §4.5.3): where
 * OSM does not say, the app does not assert. Silence about a beach is not
 * permission to take a dog onto it.
 */
const VERIFY_SIGNAGE = "Verify signage on site";

/** A `dog:conditional` this app could not read. Something about dogs here is
 *  conditional and we cannot say what, which escalates to the same advice. */
const UNPARSED_SEASONAL = "Seasonal rules apply — check signs on site";

/** Separates the tag labels on a row. */
const TAG_SEPARATOR = " · ";

export interface SpotListCallbacks {
  /**
   * A row was tapped. `null` when the tap cleared the selection — tapping the
   * already-selected row deselects it.
   */
  onSelect: (id: string | null) => void;
  /** The row's "open in maps" button was tapped. */
  onDirections: (id: string) => void;
}

/** A spot paired with how far it is from where the user is standing *now*. */
export interface RankedSpot {
  spot: DogSpot;
  meters: number;
}

/**
 * The spots, nearest first, each carrying its distance from `position`.
 *
 * Sorting by distance from the user's current position is a hard requirement
 * (docs/spec.md §2.2). Distance is a function of where the user is standing,
 * so it is computed here on every render rather than stored on the spot: walk
 * a couple of streets and the same spots re-sort themselves.
 *
 * The caller's array is left alone.
 */
export function sortByDistanceFrom(
  position: LatLon,
  spots: DogSpot[],
): RankedSpot[] {
  return spots
    .map((spot) => ({ spot, meters: haversineMeters(position, spot) }))
    .sort((a, b) => a.meters - b.meters);
}

/**
 * The name to show for a spot.
 *
 * Verbatim, whatever OSM says. Some names are odd — one Stockholm park is
 * mapped as "Category:Vanadislundens hundrastgård" — but tidying them up here
 * would quietly disagree with what the same park is called in every other OSM
 * app, and with the label the user will read on the sign.
 */
export function spotLabel({ name, kind }: DogSpot): string {
  return name !== undefined && name.trim() !== "" ? name : UNNAMED[kind];
}

/**
 * The tags worth showing, as short labels, in the order spec §7.3 lists them.
 *
 * An absent tag produces nothing at all, and that is the entire point: in OSM
 * an absent `fenced` means *nobody has said*, and rendering it as "not fenced"
 * would turn silence into a confident claim the data does not support
 * (docs/spec.md §3, and the doc comment on {@link SpotTags}). A tag that is
 * present and false is a different statement — someone surveyed it and wrote
 * down "no" — so that one is shown.
 */
export function describeTags(tags: SpotTags): string[] {
  const labels: string[] = [];

  if (tags.fenced !== undefined) {
    labels.push(tags.fenced ? "Fenced" : "Not fenced");
  }
  if (tags.lit !== undefined) {
    labels.push(tags.lit ? "Lit" : "Not lit");
  }
  if (tags.surface !== undefined) {
    labels.push(`Surface: ${readableSurface(tags.surface)}`);
  }

  return labels;
}

/** What a bathing row says about the season, and how loudly. */
interface SeasonalCaption {
  text: string;
  /**
   * Whether the ban is in force *today*. The row itself is marked when it is,
   * not just the words — a caption is easy to read past, and this is the one
   * thing on the row that can cost the reader a fine.
   */
  bannedNow: boolean;
}

/**
 * The one seasonal line every bathing row carries.
 *
 * Exactly one, always, and never absent. OSM records existence, not current
 * legality (docs/spec.md §4.5.3): in Stockholm dogs are banned from public
 * beaches roughly 1 June – 31 August, and a bathing spot that looks confident
 * in July can send someone to a beach where their dog is illegal — a worse
 * outcome than showing no result at all. So an absent `dog:conditional`
 * produces the verify-signage default rather than silence.
 *
 * Ordered by how much the data lets us say. A ban in force today is the
 * strongest thing we can state and the only one that changes what the reader
 * should do in the next hour, so it leads with "now" and still names the
 * window. A ban out of season names the window too, because someone reading
 * this in May is planning a trip in July. An unparsed rule says only that
 * there is something to check. None of the four asserts that dogs are welcome:
 * this app has no state that means "verified fine, go ahead".
 */
function seasonalCaption(spot: DogSpot, today: Date): SeasonalCaption {
  const { seasonal } = spot;
  if (seasonal === undefined) return { text: VERIFY_SIGNAGE, bannedNow: false };
  if (seasonal.kind === "unparsed") {
    return { text: UNPARSED_SEASONAL, bannedNow: false };
  }

  // En dash, spaced, because this is a range between two dates rather than a
  // hyphenated compound.
  const window = `${formatMonthDay(seasonal.from)} – ${formatMonthDay(seasonal.to)}`;
  return isBannedOn(seasonal, today)
    ? { text: `Dogs banned now (${window})`, bannedNow: true }
    : { text: `Dogs banned ${window}`, bannedNow: false };
}

export interface SpotListOptions {
  /**
   * The date the seasonal captions are decided against. Defaults to now.
   *
   * Injectable because "banned *now*" is a claim about the clock, and a test
   * that read the real one would say something different in August than in
   * January — the two answers a test must never choose between.
   */
  today?: Date;
}

/**
 * Render the list into `container`, replacing whatever is there.
 *
 * Idempotent: calling it again with a new position re-sorts, and calling it
 * again with a different `selectedId` moves the selection. That is how the
 * selection stays re-assertable from outside — the map pins (bead
 * zoomies-bgc.12) select rows by re-rendering, exactly as a tap does.
 */
export function renderSpotList(
  container: HTMLElement,
  spots: DogSpot[],
  position: LatLon,
  selectedId: string | null,
  callbacks: SpotListCallbacks,
  { today = new Date() }: SpotListOptions = {},
): void {
  const focused = focusedControl(container);

  // Ordered, because the order is the information: nearest first.
  const list = document.createElement("ol");
  list.className = "spot-list";
  // "Results", not "Dog parks": the list holds both layers now, and naming one
  // of them would leave a screen-reader user hunting for a bathing spot in a
  // list that told them it contained parks.
  list.setAttribute("aria-label", "Results, nearest first");

  for (const ranked of sortByDistanceFrom(position, spots)) {
    list.append(renderRow(ranked, selectedId, callbacks, today));
  }

  // One atomic swap rather than emptying and refilling: the container keeps
  // its scroll position, and the list never flickers through empty. This is
  // called on every GPS tick.
  container.replaceChildren(list);

  restoreFocus(list, focused);
}

function renderRow(
  { spot, meters }: RankedSpot,
  selectedId: string | null,
  callbacks: SpotListCallbacks,
  today: Date,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "spot-list-item";

  const label = spotLabel(spot);
  const selected = spot.id === selectedId;

  const select = document.createElement("button");
  select.type = "button";
  select.className = "spot-list-select";
  select.dataset.spotId = spot.id;
  select.dataset.spotAction = "select";
  // A toggle rather than a radio: tapping the selected row again clears the
  // selection, which is also the only way this list ever reports `null`.
  // The attribute is the selected state — the stylesheet keys off it, so the
  // look and the announcement cannot drift apart.
  select.setAttribute("aria-pressed", String(selected));
  select.addEventListener("click", () => {
    callbacks.onSelect(selected ? null : spot.id);
  });

  const name = document.createElement("span");
  name.className = "spot-list-name";
  name.textContent = label;

  const distance = document.createElement("span");
  distance.className = "spot-list-distance";
  distance.textContent = formatDistance(meters);

  select.append(name, distance);

  // Beside the name, so the layer a row belongs to is answered before the
  // reader has parsed anything else on it — and coloured like the pin, so the
  // map and the list agree without either explaining itself.
  //
  // *Inside* the name rather than next to it, so it flows with the words and
  // wraps after them. As a column of its own it took its width off the name,
  // and at 375px that broke "Smedsuddsbadets hundbad" across two lines
  // mid-word — the same trade the directions button already lost (see the
  // narrow-screen rules in src/styles.css): the name is the information.
  if (spot.kind === "bathing_spot") {
    const badge = document.createElement("span");
    badge.className = "spot-list-kind";
    badge.textContent = BATHING_BADGE;
    name.append(" ", badge);
  }

  const tags = describeTags(spot.tags);
  if (tags.length > 0) {
    const tagLine = document.createElement("span");
    tagLine.className = "spot-list-tags";
    // One text node, not a chip per tag: the separators then survive into the
    // button's accessible name, so a screen reader says "Fenced, Lit" instead
    // of running them together.
    tagLine.textContent = tags.join(TAG_SEPARATOR);
    select.append(tagLine);
  }

  // Everything a bathing spot has to disclose goes inside the select button
  // for the same reason the tags line does: it lands in the button's
  // accessible name, so a screen-reader user hears the caveats as part of the
  // row rather than as loose text they might tab straight past.
  if (spot.kind === "bathing_spot") {
    const provenance = document.createElement("span");
    provenance.className = "spot-list-provenance";
    provenance.textContent = PROVENANCE_LABELS[spot.provenance];

    const caveat = document.createElement("span");
    caveat.className = "spot-list-caveat";
    const seasonal = seasonalCaption(spot, today);
    caveat.textContent = seasonal.text;

    // The whole row is marked, not just the caption: the stylesheet turns the
    // warning up and everything around it down, so a ban in force is the one
    // thing on the row the eye cannot miss.
    if (seasonal.bannedNow) select.dataset.banned = "true";

    select.append(provenance, caveat);
  }

  const directions = document.createElement("button");
  directions.type = "button";
  directions.className = "spot-list-directions";
  directions.dataset.spotId = spot.id;
  directions.dataset.spotAction = "directions";

  // The words and the arrow are separate elements so a narrow screen can drop
  // the words and keep the button. On a phone the label cost more width than
  // the park's name was getting, which is backwards: the name is the
  // information, and the button is the same on every row. The accessible name
  // below is unaffected either way.
  const directionsIcon = document.createElement("span");
  directionsIcon.className = "spot-list-directions-icon";
  directionsIcon.setAttribute("aria-hidden", "true");
  directionsIcon.textContent = "➔";

  const directionsLabel = document.createElement("span");
  directionsLabel.className = "spot-list-directions-label";
  directionsLabel.textContent = "Open in maps";

  directions.append(directionsIcon, directionsLabel);
  // Every row's button says the same three words, so the park's name goes in
  // the accessible name; otherwise a screen reader listing the buttons on the
  // page reads "Open in maps" a dozen times with nothing to tell them apart.
  directions.setAttribute("aria-label", `Open in maps: ${label}`);
  // No URL is built here and `navigator` is never read. Which maps app to
  // open, and whether to hand it an origin, is one decision made in one place
  // — the state machine already makes it (docs/spec.md §7.4). The list only
  // says which spot the user asked about.
  directions.addEventListener("click", () => {
    callbacks.onDirections(spot.id);
  });

  item.append(select, directions);
  return item;
}

/**
 * OSM surface values are lower_snake_case; the underscore is OSM's spelling,
 * not part of the word. Nothing else is touched — the vocabulary is open, so
 * a value we have never seen is passed through as it was mapped rather than
 * dropped for not matching an enum.
 */
function readableSurface(surface: string): string {
  return surface.replace(/_/g, " ");
}

/** Which control the user is on, if any, as something a rebuilt list can be
 *  searched for. */
interface FocusedControl {
  spotId: string;
  action: string;
}

function focusedControl(container: HTMLElement): FocusedControl | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) {
    return null;
  }

  const { spotId, spotAction } = active.dataset;
  return spotId !== undefined && spotAction !== undefined
    ? { spotId, action: spotAction }
    : null;
}

/**
 * Put keyboard focus back where it was.
 *
 * Rebuilding the list throws away the element the user was on, and this list
 * is rebuilt on every GPS tick — without this, focus would fall back to the
 * document body every second or so, which makes the app unusable from a
 * keyboard and loses the user's place under a screen reader.
 */
function restoreFocus(list: HTMLElement, focused: FocusedControl | null): void {
  if (!focused) return;

  for (const control of list.querySelectorAll("button")) {
    if (
      control.dataset.spotId === focused.spotId &&
      control.dataset.spotAction === focused.action
    ) {
      control.focus();
      return;
    }
  }
}
