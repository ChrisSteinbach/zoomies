// Drag gesture handling for the map drawer.
// Uses PointerEvents for unified touch/mouse support.
// Click-to-toggle uses the native click event to avoid mobile ghost clicks.
//
// The drawer slides horizontally: dragging the handle left opens it, right
// closes it. Zero imports, and no knowledge of what is inside the drawer — it
// moves a panel and reports the outcome.

export interface DrawerGestureOpts {
  panel: HTMLElement;
  handle: HTMLElement;
  /** Returns the drawer width for clamping (e.g. panel.offsetWidth or window.innerWidth). */
  getDrawerWidth: () => number;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

/** Velocity threshold in px/ms — swipes faster than this always snap. */
const VELOCITY_THRESHOLD = 0.5;
/** Position threshold as fraction of drawer width for slow drags. */
const POSITION_THRESHOLD = 0.5;
/** Max pixels moved before a pointerdown→pointerup counts as a drag, not a click. */
const CLICK_THRESHOLD = 5;

export function setupDrawerGesture(opts: DrawerGestureOpts): () => void {
  const { panel, handle, getDrawerWidth, open, close, isOpen } = opts;

  let startX = 0;
  let startTime = 0;
  let startOpen = false;
  let pointerDown = false;
  let hasMoved = false;
  let pointerId = -1;
  let cachedDrawerWidth = 0;

  function onPointerDown(e: PointerEvent): void {
    if (pointerDown) return; // ignore second finger
    pointerDown = true;
    hasMoved = false;
    startX = e.clientX;
    startTime = e.timeStamp;
    startOpen = isOpen();
    pointerId = e.pointerId;
    cachedDrawerWidth = getDrawerWidth();

    // Don't capture yet — delay until drag threshold is exceeded.
    // Capturing immediately interferes with the click event chain on
    // mobile, causing ghost clicks on elements underneath the handle.
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointerDown || e.pointerId !== pointerId) return;

    const deltaX = e.clientX - startX;

    // Don't enter drag mode until pointer has moved past click threshold
    if (!hasMoved) {
      if (Math.abs(deltaX) < CLICK_THRESHOLD) return;
      hasMoved = true;
      // Now capture — we're committed to a drag gesture
      handle.setPointerCapture(pointerId);
      // Enter drag mode: take over transform
      panel.classList.add("dragging");
      panel.classList.remove("open");
      panel.style.transform = startOpen
        ? "translateX(0)"
        : `translateX(${cachedDrawerWidth}px)`;
    }

    // Calculate current translateX based on start state + drag delta
    const baseOffset = startOpen ? 0 : cachedDrawerWidth;
    const rawOffset = baseOffset + deltaX;

    // Clamp: 0 = fully open, drawerWidth = fully closed
    const clampedOffset = Math.max(0, Math.min(cachedDrawerWidth, rawOffset));
    panel.style.transform = `translateX(${clampedOffset}px)`;
  }

  function onPointerUp(e: PointerEvent): void {
    if (!pointerDown || e.pointerId !== pointerId) return;
    pointerDown = false;

    // Click (no significant drag) — let the click event handler toggle.
    if (!hasMoved) return;

    const deltaX = e.clientX - startX;
    const deltaTime = e.timeStamp - startTime;
    const velocity = deltaTime > 0 ? deltaX / deltaTime : 0;

    // Calculate where the drawer ended up
    const baseOffset = startOpen ? 0 : cachedDrawerWidth;
    const rawOffset = baseOffset + deltaX;
    const clampedOffset = Math.max(0, Math.min(cachedDrawerWidth, rawOffset));
    const openFraction = 1 - clampedOffset / cachedDrawerWidth;

    // Remove inline transform and dragging class — let CSS transition take over
    panel.style.transform = "";
    panel.classList.remove("dragging");

    // Decide: velocity-based snap or position-based threshold
    if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
      // Negative velocity = dragged left = opening
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
