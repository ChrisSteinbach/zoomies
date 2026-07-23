// The drawer the result list lives in: a full-height panel that slides in from
// the right edge, over the map.
//
// On a phone — which is where this app is actually used — the list and the map
// are both wanted and there is only one screen. The drawer is the answer: the
// list slides over the map when the list is what you want, and off to the right
// when the map is. Its round handle rides the panel's left edge, vertically
// centred, so it is on screen and under a thumb in both states — a drawer you
// can close and not reopen is a drawer that ate your results.
//
// It owns the sliding panel and nothing that goes in it. The content element is
// handed back for the caller to render the list into, so this module never
// learns what a dog park is.

import { setupDrawerGesture } from "./drawer-gesture";
import "./spot-drawer.css";

export interface SpotDrawer {
  /** The content area, for the caller to render the list into. */
  element: HTMLElement;
  /** The sliding panel, so the caller can size or hide the whole drawer. */
  panel: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /**
   * Put keyboard focus on the handle — the way back in.
   *
   * For a caller that closes the drawer out from under the focused control:
   * leaving focus inside the parked-off-screen panel strands a keyboard user
   * in furniture they can no longer see, and the next focus-reveal scroll
   * would drag the shell sideways to show it. The handle is where the
   * closed drawer keeps its one visible control.
   */
  focusHandle(): void;
  /** Removes the drawer and unbinds the gesture. */
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The glyph on the handle: a chevron pointing the way the drawer will go. It
 * points left while closed — pull the list in — and is flipped by CSS to point
 * right once open, back the way it came. Decorative; the button's own label is
 * what gets announced.
 */
function createChevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "spot-drawer-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M15 5 8 12l7 7");
  svg.append(path);

  return svg;
}

/**
 * Mount the drawer inside `container`, which must be positioned — the panel is
 * absolutely placed against its right edge, over the map, and takes its full
 * height.
 *
 * It opens *open*. The nearest dog parks are the answer the user came for; the
 * map is the context for that answer, so the list is what they should be
 * looking at when the results arrive.
 */
export function createSpotDrawer(container: HTMLElement): SpotDrawer {
  const panel = document.createElement("div");
  panel.className = "spot-drawer open";

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "spot-drawer-handle";
  // "Results", not "dog parks": the list this handle hides holds both layers
  // (spot-list.ts), and the drawer itself has never known what is in it.
  handle.setAttribute("aria-label", "Show or hide the list of results");
  handle.setAttribute("aria-expanded", "true");
  handle.append(createChevron());

  const content = document.createElement("div");
  content.className = "spot-drawer-content";

  panel.append(handle, content);
  container.append(panel);

  function open(): void {
    panel.classList.add("open");
    handle.setAttribute("aria-expanded", "true");
  }

  function close(): void {
    panel.classList.remove("open");
    handle.setAttribute("aria-expanded", "false");
  }

  function toggle(): void {
    if (isOpen()) {
      close();
    } else {
      open();
    }
  }

  // The class is the state, so what is drawn and what is announced cannot drift
  // apart. A drag in progress removes it while the panel follows the finger —
  // the gesture reads the state once, at pointerdown, precisely so that
  // in-between position is nobody else's business.
  function isOpen(): boolean {
    return panel.classList.contains("open");
  }

  const destroyGesture = setupDrawerGesture({
    panel,
    handle,
    // The travel: the panel's own width, which is what the closed transform in
    // spot-drawer.css slides it by. The handle is carried back over the map by
    // a transform of its own, so it costs the drag nothing.
    getDrawerWidth: () => panel.offsetWidth,
    open,
    close,
    isOpen,
  });

  return {
    element: content,
    panel,
    open,
    close,
    toggle,
    isOpen,
    focusHandle() {
      handle.focus({ preventScroll: true });
    },
    destroy() {
      destroyGesture();
      panel.remove();
    },
  };
}
