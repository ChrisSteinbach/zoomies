// Drag gesture handling for the bottom-sheet drawer.
// Uses PointerEvents for unified touch/mouse support.
// Click-to-toggle uses the native click event to avoid mobile ghost clicks.
//
// The drawer slides vertically: dragging the handle up opens it, down closes
// it. Zero imports, and no knowledge of what is inside the drawer — it moves a
// panel and reports the outcome.

export interface DrawerGestureOpts {
  panel: HTMLElement;
  handle: HTMLElement;
  /**
   * How far the panel travels between open and closed, in pixels — the height
   * of the part that slides out of view (e.g.
   * `panel.offsetHeight - handle.offsetHeight`, when the handle stays visible).
   */
  getDrawerHeight: () => number;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

/** Velocity threshold in px/ms — swipes faster than this always snap. */
const VELOCITY_THRESHOLD = 0.5;
/** Position threshold as fraction of drawer height for slow drags. */
const POSITION_THRESHOLD = 0.5;
/** Max pixels moved before a pointerdown→pointerup counts as a drag, not a click. */
const CLICK_THRESHOLD = 5;

export function setupDrawerGesture(opts: DrawerGestureOpts): () => void {
  const { panel, handle, getDrawerHeight, open, close, isOpen } = opts;

  let startY = 0;
  let startTime = 0;
  let startOpen = false;
  let pointerDown = false;
  let hasMoved = false;
  let pointerId = -1;
  let cachedDrawerHeight = 0;

  function onPointerDown(e: PointerEvent): void {
    if (pointerDown) return; // ignore second finger
    pointerDown = true;
    hasMoved = false;
    startY = e.clientY;
    startTime = e.timeStamp;
    startOpen = isOpen();
    pointerId = e.pointerId;
    cachedDrawerHeight = getDrawerHeight();

    // Don't capture yet — delay until drag threshold is exceeded.
    // Capturing immediately interferes with the click event chain on
    // mobile, causing ghost clicks on elements underneath the handle.
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointerDown || e.pointerId !== pointerId) return;

    const deltaY = e.clientY - startY;

    // Don't enter drag mode until pointer has moved past click threshold
    if (!hasMoved) {
      if (Math.abs(deltaY) < CLICK_THRESHOLD) return;
      hasMoved = true;
      // Now capture — we're committed to a drag gesture
      handle.setPointerCapture(pointerId);
      // Enter drag mode: take over transform
      panel.classList.add("dragging");
      panel.classList.remove("open");
      panel.style.transform = startOpen
        ? "translateY(0)"
        : `translateY(${cachedDrawerHeight}px)`;
    }

    // Calculate current translateY based on start state + drag delta
    const baseOffset = startOpen ? 0 : cachedDrawerHeight;
    const rawOffset = baseOffset + deltaY;

    // Clamp: 0 = fully open, drawerHeight = fully closed
    const clampedOffset = Math.max(0, Math.min(cachedDrawerHeight, rawOffset));
    panel.style.transform = `translateY(${clampedOffset}px)`;
  }

  function onPointerUp(e: PointerEvent): void {
    if (!pointerDown || e.pointerId !== pointerId) return;
    pointerDown = false;

    // Click (no significant drag) — let the click event handler toggle.
    if (!hasMoved) return;

    const deltaY = e.clientY - startY;
    const deltaTime = e.timeStamp - startTime;
    const velocity = deltaTime > 0 ? deltaY / deltaTime : 0;

    // Calculate where the drawer ended up
    const baseOffset = startOpen ? 0 : cachedDrawerHeight;
    const rawOffset = baseOffset + deltaY;
    const clampedOffset = Math.max(0, Math.min(cachedDrawerHeight, rawOffset));
    const openFraction = 1 - clampedOffset / cachedDrawerHeight;

    // Remove inline transform and dragging class — let CSS transition take over
    panel.style.transform = "";
    panel.classList.remove("dragging");

    // Decide: velocity-based snap or position-based threshold
    if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
      // Negative velocity = dragged up = opening
      if (velocity < 0) {
        open();
      } else {
        close();
      }
    } else {
      if (openFraction >= POSITION_THRESHOLD) {
        open();
      } else {
        close();
      }
    }
  }

  function onPointerCancel(_: PointerEvent): void {
    if (!pointerDown) return;
    pointerDown = false;

    // Snap back to original state
    panel.style.transform = "";
    panel.classList.remove("dragging");
    if (startOpen) {
      open();
    } else {
      close();
    }
  }

  function onClick(e: MouseEvent): void {
    // Only handle clicks that weren't drags
    if (hasMoved) return;
    e.stopPropagation();
    if (isOpen()) {
      close();
    } else {
      open();
    }
  }

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerCancel);
  handle.addEventListener("click", onClick);

  return function destroy(): void {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerUp);
    handle.removeEventListener("pointercancel", onPointerCancel);
    handle.removeEventListener("click", onClick);
  };
}
