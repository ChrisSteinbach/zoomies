// The segmented control that shows which position source is active — the
// device's GPS or a hand-picked spot — and offers the other one.
//
// A view and nothing else, exactly like the layer toggle beside it: it is
// handed the current position source and renders two buttons, pressed or
// not, busy or not. What a tap actually *does* is the composition root's
// business, delivered through the callbacks. Ported in spirit from
// tour-guide's mode toggle — same two-icon-button shape — but with one
// deliberate difference: no confirm() before re-picking. Tour-guide's picker
// has no way out once opened; zoomies' has its own Cancel button, so opening
// it over an existing pick is freely reversible and needs no gate.
//
// The buttons are created once and mutated after that. This renders on every
// state change, and the callbacks bound to them at creation must not close
// over per-render data — they will outlive the render that created them,
// exactly as status-view.ts's do. Replacing the buttons instead of mutating
// them would throw keyboard focus off whichever one had it.

import { createSatelliteIcon, createMapIcon } from "./icons";

export interface ModeToggleCallbacks {
  /** The user asked to follow the device again. */
  onFollow: () => void;
  /** The user asked to choose a position on the map. */
  onPick: () => void;
}

/**
 * Render the toggle into `container`, updating in place.
 *
 * `source` is the state machine's `positionSource`: `"gps"` while following
 * the device, `"picked"` for a hand-chosen spot, and `null` for the gap
 * between them — the user asked to follow again and no fix has landed yet.
 * The GPS button reads pressed for both `"gps"` and `null`: a resume in
 * flight is already "this is what's happening", and `aria-busy` is what
 * tells the still-waiting case apart from the settled one.
 */
export function renderModeToggle(
  container: HTMLElement,
  source: "gps" | "picked" | null,
  callbacks: ModeToggleCallbacks,
): void {
  const { gpsButton, pickButton } = ensureButtons(container, callbacks);

  const following = source !== "picked";
  const resuming = source === null;
  gpsButton.setAttribute("aria-pressed", String(following));
  gpsButton.setAttribute("aria-busy", String(resuming));
  const gpsLabel = resuming
    ? "Finding you…"
    : following
      ? "Following your location"
      : "Follow my location";
  gpsButton.setAttribute("aria-label", gpsLabel);
  gpsButton.title = gpsLabel;

  const picked = source === "picked";
  pickButton.setAttribute("aria-pressed", String(picked));
  const pickLabel = picked
    ? "Choose a different spot on the map"
    : "Choose a spot on the map";
  pickButton.setAttribute("aria-label", pickLabel);
  pickButton.title = pickLabel;
}

function ensureButtons(
  container: HTMLElement,
  callbacks: ModeToggleCallbacks,
): { gpsButton: HTMLButtonElement; pickButton: HTMLButtonElement } {
  const existingGps =
    container.querySelector<HTMLButtonElement>(".mode-toggle-gps");
  const existingPick =
    container.querySelector<HTMLButtonElement>(".mode-toggle-pick");
  if (existingGps && existingPick) {
    return { gpsButton: existingGps, pickButton: existingPick };
  }

  const group = document.createElement("div");
  group.className = "mode-toggle";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Position source");

  const gpsButton = document.createElement("button");
  gpsButton.type = "button";
  gpsButton.className = "mode-toggle-btn mode-toggle-gps";
  gpsButton.append(createSatelliteIcon());
  // Read from the button itself, not a variable closed over at bind time:
  // the attribute is the render's most recent word on what is currently
  // happening. Pressed or busy, following is already underway and a tap on
  // it has nothing to do.
  gpsButton.addEventListener("click", () => {
    if (gpsButton.getAttribute("aria-pressed") === "false") {
      callbacks.onFollow();
    }
  });

  const pickButton = document.createElement("button");
  pickButton.type = "button";
  pickButton.className = "mode-toggle-btn mode-toggle-pick";
  pickButton.append(createMapIcon());
  pickButton.addEventListener("click", () => callbacks.onPick());

  group.append(gpsButton, pickButton);
  container.append(group);

  return { gpsButton, pickButton };
}
