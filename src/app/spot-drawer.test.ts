// @vitest-environment jsdom
//
// The sheet's own behaviour: the state it opens in, what it announces, and
// that the drag gesture is actually attached to it. The gesture's own corners
// are covered in drawer-gesture.test.ts. How the sheet *feels* — whether the
// handle is thumb-reachable, whether the map is still readable behind it — is a
// browser check at 375×667, not something jsdom can answer.

import { createSpotDrawer } from "./spot-drawer";

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
  opts: { clientY: number; timeStamp: number },
): PointerEvent {
  const e = new PointerEvent(type, {
    clientY: opts.clientY,
    pointerId: 1,
    bubbles: true,
  });
  Object.defineProperty(e, "timeStamp", { value: opts.timeStamp });
  return e;
}

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

function handleOf(container: HTMLElement): HTMLButtonElement {
  const handle = container.querySelector<HTMLButtonElement>(
    ".spot-drawer-handle",
  )!;
  // jsdom doesn't implement pointer capture, and the gesture takes it mid-drag.
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  return handle;
}

/**
 * Give the sheet a size. jsdom lays nothing out, so every element measures
 * zero — and the travel distance the gesture divides by comes from measuring
 * the panel against its handle.
 */
function size(panel: HTMLElement, handle: HTMLElement): void {
  Object.defineProperty(panel, "offsetHeight", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(handle, "offsetHeight", {
    configurable: true,
    value: 44,
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("createSpotDrawer", () => {
  it("opens showing the list", () => {
    const drawer = createSpotDrawer(mount());

    // The nearest dog parks are what the user came for; the map is the context
    // for them. Arriving at a covered list would hide the answer.
    expect(drawer.isOpen()).toBe(true);
  });

  it("opens and closes on request", () => {
    const drawer = createSpotDrawer(mount());

    drawer.close();
    expect(drawer.isOpen()).toBe(false);

    drawer.open();
    expect(drawer.isOpen()).toBe(true);
  });

  it("toggle() flips the state", () => {
    const drawer = createSpotDrawer(mount());

    drawer.toggle();
    expect(drawer.isOpen()).toBe(false);

    drawer.toggle();
    expect(drawer.isOpen()).toBe(true);
  });

  it("announces whether it is open", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);

    expect(handle.getAttribute("aria-expanded")).toBe("true");

    drawer.close();
    expect(handle.getAttribute("aria-expanded")).toBe("false");

    drawer.toggle();
    expect(handle.getAttribute("aria-expanded")).toBe("true");
  });

  it("gives the caller somewhere to render the list", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);

    const list = document.createElement("ol");
    drawer.element.append(list);

    expect(drawer.panel.contains(list)).toBe(true);
  });

  it("has a button for a handle, so a keyboard can work it too", () => {
    const container = mount();
    createSpotDrawer(container);

    const handle = handleOf(container);
    expect(handle.tagName).toBe("BUTTON");
    // A button fires a native click on Enter and Space, which is the same
    // event the toggle already hangs off for touch.
    expect(handle.getAttribute("aria-label")).toMatch(/list/i);
  });

  it("closes when the handle is flicked down", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);
    size(drawer.panel, handle);

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientY: 200, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientY: 240, timeStamp: 20 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientY: 240, timeStamp: 20 }),
    );

    expect(drawer.isOpen()).toBe(false);
  });

  it("springs back when a drag stops short of the halfway point", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);
    size(drawer.panel, handle);

    // Slow, so the decision is made on position rather than velocity: 100px of
    // a 356px travel, which is not enough to mean it.
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientY: 200, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientY: 300, timeStamp: 800 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientY: 300, timeStamp: 800 }),
    );

    expect(drawer.isOpen()).toBe(true);
  });

  it("destroy() takes the sheet off the screen", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);

    drawer.destroy();

    expect(container.querySelector(".spot-drawer")).toBeNull();
  });

  it("stops listening to the handle once destroyed", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);

    drawer.destroy();
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(drawer.isOpen()).toBe(true);
  });
});
