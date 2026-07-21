// The bottom sheet the result list lives in, over the map.
//
// On a phone — which is where this app is actually used — the list and the map
// are both wanted and there is only one screen. The sheet is the answer: the
// list sits on top of the map and is dragged down out of the way when the map
// is what you want, and back up when the list is.
//
// It owns the sliding panel and nothing that goes in it. The content element is
// handed back for the caller to render the list into, so this module never
// learns what a dog park is.

import { setupDrawerGesture } from "./drawer-gesture";
import "./spot-drawer.css";

export interface SpotDrawer {
  /** The content area, for the caller to render the list into. */
  element: HTMLElement;
  /** The sliding panel, so the caller can size or hide the whole sheet. */
  panel: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Removes the sheet and unbinds the gesture. */
  destroy(): void;
}

/**
 * Mount the sheet inside `container`, which must be positioned — the sheet is
 * absolutely placed against its bottom edge, over the map.
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
  handle.setAttribute("aria-label", "Show or hide the list of dog parks");
  handle.setAttribute("aria-expanded", "true");

  // The grabber every bottom sheet has. Decorative: the button's own label is
  // what gets announced.
  const grip = document.createElement("span");
  grip.className = "spot-drawer-grip";
  grip.setAttribute("aria-hidden", "true");
  handle.append(grip);

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
    // The travel: everything but the handle, which stays on screen when the
    // sheet is down so there is always something to drag back up. Matches the
    // closed transform in spot-drawer.css.
    getDrawerHeight: () => panel.offsetHeight - handle.offsetHeight,
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
    destroy() {
      destroyGesture();
      panel.remove();
    },
  };
}
