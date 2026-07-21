// The result list: every dog park we found, nearest first (docs/spec.md §7.3).
//
// A view and nothing else. It is handed the spots, where the user is, and
// which row is selected, and it renders them. It owns no state, runs no
// transitions and fetches nothing; everything it has to say goes out through
// the callbacks, so the composition root remains the only place that knows
// what selecting a row or asking for directions actually *does*.

import type { DogSpot, LatLon, SpotTags } from "./types";
import { haversineMeters } from "./geo";
import { formatDistance } from "./format";

/**
 * What we show when OSM has no name for a park.
 *
 * Plenty of real dog parks are genuinely unnamed, so this is a label for a
 * known place rather than an apology for missing data (docs/spec.md §7.3).
 */
const UNNAMED = "Unnamed dog park";

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
export function spotLabel({ name }: DogSpot): string {
  return name !== undefined && name.trim() !== "" ? name : UNNAMED;
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
): void {
  const focused = focusedControl(container);

  // Ordered, because the order is the information: nearest first.
  const list = document.createElement("ol");
  list.className = "spot-list";
  list.setAttribute("aria-label", "Dog parks, nearest first");

  for (const ranked of sortByDistanceFrom(position, spots)) {
    list.append(renderRow(ranked, selectedId, callbacks));
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

  const directions = document.createElement("button");
  directions.type = "button";
  directions.className = "spot-list-directions";
  directions.dataset.spotId = spot.id;
  directions.dataset.spotAction = "directions";
  directions.textContent = "Open in maps";
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
