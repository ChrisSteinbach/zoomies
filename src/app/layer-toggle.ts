// The switch for the bathing-spots layer, and the one line of honesty next
// to it.
//
// A view and nothing else, like the list: it is handed the layer's state and
// renders a chip plus, when there is something to say, a short note — looking,
// found nothing within how far, or failed with a retry. What the chip *does*
// is the composition root's business, delivered through the callbacks.
//
// Phase 3 plans more toggleable layers (docs/spec.md §4.4); this widget is
// deliberately shaped as "a chip and its note" so the next layer is another
// chip in the same row rather than another pattern.

import { formatDistance } from "./format";
import type { BathingLayer } from "./state-machine";

export interface LayerToggleCallbacks {
  /** The chip was tapped: switch the layer on or off. */
  onToggle: () => void;
  /** The note's retry button was tapped, after a failure. */
  onRetry: () => void;
}

const CHIP_LABEL = "Bathing spots";

/**
 * Render the toggle into `container`, updating in place.
 *
 * In place rather than rebuilt: this is called on every render pass, GPS
 * ticks included, and replacing the chip element would throw keyboard focus
 * off it about once a second. The chip is created once and mutated; only the
 * note — which focus is never on — is rebuilt when its content changes.
 */
export function renderLayerToggle(
  container: HTMLElement,
  bathing: BathingLayer,
  callbacks: LayerToggleCallbacks,
): void {
  const chip = ensureChip(container, callbacks);

  const on = bathing.kind !== "off";
  const loading = bathing.kind === "loading";
  // The attribute is the state, for the stylesheet and the screen reader
  // alike — a pressed chip is an on layer, a busy chip is one still looking.
  chip.setAttribute("aria-pressed", String(on));
  chip.setAttribute("aria-busy", String(loading));

  renderNote(container, bathing, callbacks);
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

/**
 * What the note should say for this state, or nothing.
 *
 * `ready` with spots says nothing — the spots themselves, in the list below,
 * are the answer. `ready` with none says how far was searched, because
 * "nothing within 3 km" and "nothing within 25 km" are different statements
 * and the honest one names its reach (docs/spec.md §3).
 */
function noteFor(bathing: BathingLayer): {
  text: string;
  retry: boolean;
} | null {
  switch (bathing.kind) {
    case "off":
      return null;
    case "loading":
      return { text: "Looking for bathing spots…", retry: false };
    case "ready":
      return bathing.spots.length === 0
        ? {
            text: `No bathing spots within ${formatDistance(bathing.searchedRadiusM)}.`,
            retry: false,
          }
        : null;
    case "failed":
      return { text: "Couldn’t load bathing spots.", retry: true };
  }
}

function renderNote(
  container: HTMLElement,
  bathing: BathingLayer,
  callbacks: LayerToggleCallbacks,
): void {
  const note = noteFor(bathing);
  const existing = container.querySelector<HTMLElement>(".layer-toggle-note");

  const signature = note ? `${note.text}|${String(note.retry)}` : "";
  if (existing?.dataset.noteSignature === signature) return;
  existing?.remove();
  if (!note) return;

  const element = document.createElement("p");
  element.className = "layer-toggle-note";
  element.dataset.noteSignature = signature;
  // A live region, so "looking", "nothing within 25 km" and a failure are
  // announced without stealing focus from the chip that caused them.
  element.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = note.text;
  element.append(text);

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
