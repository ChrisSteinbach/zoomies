// @vitest-environment jsdom
//
// Adapted from tour-guide's drawer, where these cases were paid for once
// already on real phones. Two of them are the reason the module is shaped the
// way it is, and both have a test of their own below: the pointer is not
// captured until a drag has actually started, and the toggle hangs off the
// native click event. Getting either wrong produces ghost clicks on mobile —
// a tap on the handle that also lands on whatever is underneath it.

import { setupDrawerGesture } from "./drawer-gesture";

// jsdom lacks PointerEvent — polyfill it from MouseEvent
if (typeof globalThis.PointerEvent === "undefined") {
  (globalThis as Record<string, unknown>).PointerEvent =
    class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init?: PointerEventInit) {
        super(type, init);
        this.pointerId = init?.pointerId ?? 0;
      }
    };
}

function pointerEvent(
  type: string,
  opts: { clientX: number; timeStamp?: number; pointerId?: number },
): PointerEvent {
  const e = new PointerEvent(type, {
    clientX: opts.clientX,
    pointerId: opts.pointerId ?? 1,
    bubbles: true,
  });
  if (opts.timeStamp !== undefined) {
    Object.defineProperty(e, "timeStamp", { value: opts.timeStamp });
  }
  return e;
}

function createDrawer() {
  const panel = document.createElement("div");
  panel.className = "spot-drawer";
  const handle = document.createElement("div");
  handle.className = "spot-drawer-handle";
  panel.appendChild(handle);
  document.body.appendChild(panel);

  // Stub setPointerCapture/releasePointerCapture (jsdom doesn't support them)
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();

  let opened = false;
  const drawerWidth = 400;

  const destroy = setupDrawerGesture({
    panel,
    handle,
    getDrawerWidth: () => drawerWidth,
    open: () => {
      opened = true;
      panel.classList.add("open");
    },
    close: () => {
      opened = false;
      panel.classList.remove("open");
    },
    isOpen: () => opened,
  });

  return { panel, handle, destroy, isOpen: () => opened, drawerWidth };
}

/** Where a thumb lands on the handle of a closed drawer: at the right edge of
 *  the screen. */
const HANDLE_AT_REST = 360;

afterEach(() => {
  while (document.body.firstChild) document.body.firstChild.remove();
});

describe("drawer gesture", () => {
  it("drag left past 50% threshold opens the drawer", () => {
    const { handle, isOpen, drawerWidth } = createDrawer();

    // Start drag at right edge (closed state)
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    // Drag left past 50% of drawer width
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: HANDLE_AT_REST - drawerWidth * 0.6,
        timeStamp: 500,
      }),
    );
    // Release slowly (low velocity)
    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: HANDLE_AT_REST - drawerWidth * 0.6,
        timeStamp: 500,
      }),
    );

    expect(isOpen()).toBe(true);
  });

  it("drag left under 50% threshold snaps back closed", () => {
    const { handle, isOpen, drawerWidth } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: HANDLE_AT_REST - drawerWidth * 0.3,
        timeStamp: 500,
      }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: HANDLE_AT_REST - drawerWidth * 0.3,
        timeStamp: 500,
      }),
    );

    expect(isOpen()).toBe(false);
  });

  it("fast swipe left opens regardless of distance", () => {
    const { handle, isOpen } = createDrawer();

    // Fast swipe: small distance but very short time → high velocity
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 330, timeStamp: 20 }),
    );
    // velocity = -30 / 20 = -1.5 px/ms (exceeds 0.5 threshold, negative = left)
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 330, timeStamp: 20 }),
    );

    expect(isOpen()).toBe(true);
  });

  it("fast swipe right closes regardless of distance", () => {
    const { handle, isOpen } = createDrawer();

    // Open with a fast swipe left first
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 330, timeStamp: 20 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 330, timeStamp: 20 }),
    );
    expect(isOpen()).toBe(true);

    // Now swipe right fast to close
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 100, timeStamp: 1000 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 130, timeStamp: 1020 }),
    );
    // velocity = 30 / 20 = 1.5 px/ms (positive = right = close)
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 130, timeStamp: 1020 }),
    );

    expect(isOpen()).toBe(false);
  });

  it("click toggles drawer open and closed", () => {
    const { handle, isOpen } = createDrawer();

    // Click (pointerdown + pointerup + click with no movement) → opens
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: HANDLE_AT_REST, timeStamp: 100 }),
    );
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(true);

    // Click again → closes
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 200 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: HANDLE_AT_REST, timeStamp: 300 }),
    );
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(false);
  });

  it("toggles on the native click rather than on pointerup", () => {
    const { handle, isOpen } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: HANDLE_AT_REST, timeStamp: 100 }),
    );

    // Nothing yet: the toggle waits for the browser's own click. Acting on
    // pointerup instead is what produces mobile ghost clicks — the tap toggles
    // here *and* lands on whatever the drawer was covering.
    expect(isOpen()).toBe(false);

    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(true);
  });

  it("does not capture the pointer until a drag has actually started", () => {
    const { handle } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    // A finger that has not moved is still a tap in progress. Capturing now
    // breaks the click event chain on mobile.
    expect(handle.setPointerCapture).not.toHaveBeenCalled();

    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: HANDLE_AT_REST - 2,
        timeStamp: 10,
      }),
    );
    expect(handle.setPointerCapture).not.toHaveBeenCalled();

    // Past the threshold it is unambiguously a drag, and capture is what keeps
    // the moves coming once the finger leaves the handle.
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: HANDLE_AT_REST - 80,
        timeStamp: 50,
      }),
    );
    expect(handle.setPointerCapture).toHaveBeenCalledTimes(1);
  });

  it("adds dragging class only after movement past threshold", () => {
    const { handle, panel } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    // No dragging class yet — haven't moved
    expect(panel.classList.contains("dragging")).toBe(false);

    // Small move within click threshold — still no dragging
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: HANDLE_AT_REST - 2,
        timeStamp: 25,
      }),
    );
    expect(panel.classList.contains("dragging")).toBe(false);

    // Move past threshold
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 280, timeStamp: 50 }),
    );
    expect(panel.classList.contains("dragging")).toBe(true);

    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 280, timeStamp: 500 }),
    );
    expect(panel.classList.contains("dragging")).toBe(false);
  });

  it("clamps drag to valid range", () => {
    const { handle, panel, drawerWidth } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    // Drag way past fully open (negative offset)
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: HANDLE_AT_REST - drawerWidth * 2,
        timeStamp: 50,
      }),
    );

    // Transform should be clamped to translateX(0) (fully open)
    expect(panel.style.transform).toBe("translateX(0px)");

    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: HANDLE_AT_REST - drawerWidth * 2,
        timeStamp: 500,
      }),
    );
  });

  it("clamps drag to not exceed fully closed", () => {
    const { handle, panel, drawerWidth } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    // Drag right past fully closed
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: HANDLE_AT_REST + drawerWidth,
        timeStamp: 50,
      }),
    );

    // Transform should be clamped to drawerWidth (fully closed)
    expect(panel.style.transform).toBe(`translateX(${drawerWidth}px)`);

    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: HANDLE_AT_REST + drawerWidth,
        timeStamp: 500,
      }),
    );
  });

  it("removes inline transform after release", () => {
    const { handle, panel } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 280, timeStamp: 50 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 280, timeStamp: 500 }),
    );

    expect(panel.style.transform).toBe("");
  });

  it("destroy removes event listeners", () => {
    const { handle, panel, destroy } = createDrawer();

    destroy();

    // Dispatching events should have no effect
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    expect(panel.classList.contains("dragging")).toBe(false);
  });

  it("ignores second pointer while first gesture is active", () => {
    const { handle, panel, isOpen } = createDrawer();

    // First finger starts drag
    handle.dispatchEvent(
      pointerEvent("pointerdown", {
        clientX: HANDLE_AT_REST,
        pointerId: 1,
        timeStamp: 0,
      }),
    );

    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 330, pointerId: 1 }),
    );
    expect(panel.classList.contains("dragging")).toBe(true);

    // Second finger tries to start — should be ignored
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 200, pointerId: 2 }),
    );

    // Move from second pointer — should be ignored
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 100, pointerId: 2 }),
    );

    // Up from second pointer — should be ignored, gesture still active
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 100, pointerId: 2 }),
    );
    expect(panel.classList.contains("dragging")).toBe(true);

    // First pointer finishes with a fast swipe left to open
    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 330,
        pointerId: 1,
        timeStamp: 20,
      }),
    );

    expect(panel.classList.contains("dragging")).toBe(false);
    expect(isOpen()).toBe(true);
  });

  it("pointercancel restores original state", () => {
    const { handle, panel, isOpen } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: HANDLE_AT_REST, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 200, timeStamp: 50 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointercancel", { clientX: 200, timeStamp: 100 }),
    );

    expect(panel.classList.contains("dragging")).toBe(false);
    expect(panel.style.transform).toBe("");
    // Was closed initially, should stay closed
    expect(isOpen()).toBe(false);
  });
});
