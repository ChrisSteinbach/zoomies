// The switch for the bathing-spots layer, and the one line of honesty next
// to it.
//
// A view and nothing else, like the list: it is handed the layer's state and
// renders a chip plus, when there is something to say, a short note — looking,
// found what and how near, found nothing within how far, or failed with a
// retry. What the chip *does* is the composition root's business, delivered
// through the callbacks.
//
// Phase 3 plans more toggleable layers (docs/spec.md §4.4); this widget is
// deliberately shaped as "a chip and its note" so the next layer is another
// chip in the same row rather than another pattern.

import { createContributionInvitation } from "./attribution";
import { SEARCH_RADII_M } from "./expanding-search";
import { formatDistance } from "./format";
import { haversineMeters } from "./geo";
import type { BathingLayer } from "./state-machine";
import type { DogSpot, LatLon } from "./types";

export interface LayerToggleCallbacks {
  /** The chip was tapped: switch the layer on or off. */
  onToggle: () => void;
  /** The note's retry button was tapped, after a failure. */
  onRetry: () => void;
}

const CHIP_LABEL = "Bathing spots";

/**
 * Below this, the note stops naming the nearest spot's distance.
 *
 * Two reasons, one visible and one audible. Visible: within a kilometre the
 * layer has answered well, and the count alone confirms the toggle worked —
 * naming 400 m would be the note narrating a list that already shows it.
 * Audible: the note is a role=status live region and the distance comes from
 * the live position, which below 1 km formats at metre granularity
 * (format.ts) — GPS jitter alone would re-announce the note on every tick.
 * From 1 km up the format's coarser steps make a walking user's updates
 * occasional rather than constant.
 */
const NEARBY_M = 1_000;

/**
 * Beyond this, the nearest find is evidence of a data gap, not an answer.
 *
 * The first rung of the search ladder is the radius the app is content to
 * stop at, so a nearest spot beyond it means precisely that the narrowest
 * query came back empty and the layer only has something to show because it
 * widened. That is the moment docs/spec.md §4.3 asks the UI to say where the
 * fix lives, and the note says it.
 */
const LOCAL_REACH_M = SEARCH_RADII_M[0];

/**
 * Render the toggle into `container`, updating in place.
 *
 * In place rather than rebuilt: this is called on every render pass, GPS
 * ticks included, and replacing the chip element would throw keyboard focus
 * off it about once a second. The chip is created once and mutated; only the
 * note — which focus is rarely on — is rebuilt when its content changes.
 *
 * `position` is where the user stands now. The note measures its "nearest"
 * from it live, exactly as the list rows beside it do (a DogSpot carries no
 * distance; see types.ts), so the two can never disagree.
 */
export function renderLayerToggle(
  container: HTMLElement,
  bathing: BathingLayer,
  position: LatLon,
  callbacks: LayerToggleCallbacks,
): void {
  const chip = ensureChip(container, callbacks);

  const on = bathing.kind !== "off";
  const loading = bathing.kind === "loading";
  // The attribute is the state, for the stylesheet and the screen reader
  // alike — a pressed chip is an on layer, a busy chip is one still looking.
  chip.setAttribute("aria-pressed", String(on));
  chip.setAttribute("aria-busy", String(loading));

  renderNote(container, bathing, position, callbacks);
}

function ensureChip(
  container: HTMLElement,
  callbacks: LayerToggleCallbacks,
): HTMLButtonElement {
  const existing =
    container.querySelector<HTMLButtonElement>(".layer-toggle-chip");
  if (existing) return existing;

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "layer-toggle-chip";
  chip.textContent = CHIP_LABEL;
  chip.addEventListener("click", () => callbacks.onToggle());
  container.append(chip);
  return chip;
}

interface Note {
  text: string;
  retry: boolean;
  /** Append the add-it-to-OSM invitation: this answer is a data gap. */
  invite: boolean;
}

/**
 * What the note should say for this state. Only `off` says nothing.
 *
 * `ready` with spots used to stay quiet on the theory that the list below
 * was the answer — but the list sorts both layers together, and in a
 * park-dense city the nearest hundbad can sit thirty rows down: the toggle
 * read as inert exactly when its answer was least visible. So `ready` always
 * reports what it found. Constant rather than conditional on the row being
 * in view, because "in view" depends on rank, screen height and scroll, all
 * of which shift under a live re-sorting list — a note that flickered with
 * them would be noise, where this one changes only when the answer does.
 *
 * `ready` with none says how far was searched, because "nothing within 3 km"
 * and "nothing within 25 km" are different statements and the honest one
 * names its reach (docs/spec.md §3). The found case earns the same honesty
 * once the nearest find is beyond {@link NEARBY_M}: "3 bathing spots" and
 * "3 bathing spots, nearest 13 km" differ exactly as those two do.
 */
function noteFor(bathing: BathingLayer, position: LatLon): Note | null {
  switch (bathing.kind) {
    case "off":
      return null;
    case "loading":
      return {
        text: "Looking for bathing spots…",
        retry: false,
        invite: false,
      };
    case "ready":
      return readyNote(bathing.spots, bathing.searchedRadiusM, position);
    case "failed":
      // Stale spots are still on screen, so "couldn't load" would read as a
      // contradiction next to the pins the user can see. status-view.ts faces
      // the same choice for the main list and settles on the same framing:
      // a caveat on what is showing, not a claim that nothing is. No
      // invitation on either form — nothing is missing here, the service
      // broke, and recruiting a mapper would misdirect the blame.
      return bathing.staleSpots.length > 0
        ? {
            text: "These bathing spots may be out of date.",
            retry: true,
            invite: false,
          }
        : { text: "Couldn’t load bathing spots.", retry: true, invite: false };
  }
}

/** The `ready` note: what was found, how near, and — when the answer shows
 *  a gap — where the fix lives. */
function readyNote(
  spots: DogSpot[],
  searchedRadiusM: number,
  position: LatLon,
): Note {
  if (spots.length === 0) {
    return {
      text: `No bathing spots within ${formatDistance(searchedRadiusM)}.`,
      retry: false,
      invite: true,
    };
  }

  const nearestM = Math.min(
    ...spots.map((spot) => haversineMeters(position, spot)),
  );
  const count =
    spots.length === 1 ? "1 bathing spot" : `${spots.length} bathing spots`;
  const reach =
    nearestM < NEARBY_M ? "" : `, nearest ${formatDistance(nearestM)}`;

  return {
    text: `${count}${reach}.`,
    retry: false,
    // Nearest beyond the first rung ⇔ the narrowest query found nothing:
    // OSM is thin right here, whatever it holds further out.
    invite: nearestM > LOCAL_REACH_M,
  };
}

function renderNote(
  container: HTMLElement,
  bathing: BathingLayer,
  position: LatLon,
  callbacks: LayerToggleCallbacks,
): void {
  const note = noteFor(bathing, position);
  const existing = container.querySelector<HTMLElement>(".layer-toggle-note");

  if (!note) {
    existing?.remove();
    return;
  }

  // Structure and text change on different clocks, so they are handled
  // apart: which interactive pieces the note carries (retry, invitation)
  // changes only with the layer's state and rebuilds the element, while the
  // sentence itself also moves with the walker ("nearest 9.8 km" ticking
  // down) and only mutates the text node — keeping the link, the button and
  // any focus on them in place. The live region announces either way.
  const structure = `${String(note.retry)}|${String(note.invite)}`;
  if (existing?.dataset.noteStructure === structure) {
    const text = existing.querySelector<HTMLElement>(".layer-toggle-note-text");
    if (text && text.textContent !== note.text) text.textContent = note.text;
    return;
  }

  existing?.remove();

  const element = document.createElement("p");
  element.className = "layer-toggle-note";
  element.dataset.noteStructure = structure;
  // A live region, so "looking", "3 spots, nearest 13 km" and a failure are
  // announced without stealing focus from the chip that caused them.
  element.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "layer-toggle-note-text";
  text.textContent = note.text;
  element.append(text);

  if (note.invite) {
    // Inside the note element, so the invitation is announced together with
    // the finding it follows from.
    element.append(" ", createContributionInvitation("hundbad"));
  }

  if (note.retry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "layer-toggle-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => callbacks.onRetry());
    element.append(" ", retry);
  }

  container.append(element);
}
