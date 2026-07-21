// @vitest-environment jsdom
//
// The drawer's own behaviour: the state it opens in, what it announces, that
// the drag gesture is actually attached to it, and — the one the user paid for
// — that its handle is still on screen once the drawer is closed. The
// gesture's own corners are covered in drawer-gesture.test.ts. How the drawer
// *feels* — whether the handle falls under a thumb, whether the map is still
// readable beside it — is a browser check at 375×667, not something jsdom can
// answer.
//
// Where the handle is *painted* is a different question from how it feels, and
// jsdom will answer that one as long as the stylesheet is in the document —
// which is why the test guarding the closed handle puts it there by hand.

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  opts: { clientX: number; timeStamp: number },
): PointerEvent {
  const e = new PointerEvent(type, {
    clientX: opts.clientX,
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
 * Give the panel a width. jsdom lays nothing out, so every element measures
 * zero — and the travel distance the gesture divides by is the panel's width.
 * 375 is a phone, where the panel covers the screen.
 */
function size(panel: HTMLElement): void {
  Object.defineProperty(panel, "offsetWidth", {
    configurable: true,
    value: 375,
  });
}

/**
 * Put the drawer's own stylesheet in the document. The module imports it, but
 * vitest stubs CSS imports away to nothing, so the file has to be read off disk
 * for any of it to reach jsdom's cascade.
 */
function applyDrawerStyles(): void {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    join(import.meta.dirname, "spot-drawer.css"),
    "utf8",
  );
  document.head.append(style);
}

/**
 * How far an element's own transform moves it along X, as a fraction of its own
 * width. Both halves of the drawer are written that way: the panel parks itself
 * a full width to the right, and the handle pulls itself most of a width back.
 */
function xShift(element: Element): number {
  const { transform } = getComputedStyle(element);
  const match = /translate(?:X)?\(\s*(-?[\d.]+)%/.exec(transform);
  return match ? Number(match[1]) / 100 : 0;
}

afterEach(() => {
  document.body.replaceChildren();
  for (const style of document.head.querySelectorAll("style")) style.remove();
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

  it("leaves the handle on screen once the drawer is closed", () => {
    const container = mount();
    applyDrawerStyles();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);

    drawer.close();

    // The panel parks a full width to the right: entirely off the screen.
    expect(xShift(drawer.panel)).toBe(1);
    // The handle does not go with it — it hangs back over the map by most of
    // its own width. This is the whole bargain: close the drawer and the one
    // thing that brings it back is still there to be tapped. An earlier
    // version let the handle leave with the panel, and the list was gone for
    // good.
    expect(xShift(handle)).toBeLessThanOrEqual(-0.5);
    expect(getComputedStyle(handle).display).not.toBe("none");
    expect(getComputedStyle(handle).visibility).toBe("visible");
  });

  it("comes back when the handle is tapped after closing", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);
    size(drawer.panel);

    drawer.close();

    // A tap: down and up in the same place, then the browser's own click.
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 360, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 360, timeStamp: 90 }),
    );
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(drawer.isOpen()).toBe(true);
  });

  it("closes when the handle is flicked back towards the edge", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);
    size(drawer.panel);

    // Open, the handle sits against the panel's left edge, over the map.
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 18, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 48, timeStamp: 20 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 48, timeStamp: 20 }),
    );

    expect(drawer.isOpen()).toBe(false);
  });

  it("springs back when a drag stops short of the halfway point", () => {
    const container = mount();
    const drawer = createSpotDrawer(container);
    const handle = handleOf(container);
    size(drawer.panel);

    // Slow, so the decision is made on position rather than velocity: 100px of
    // a 375px travel, which is not enough to mean it.
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 18, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 118, timeStamp: 800 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 118, timeStamp: 800 }),
    );

    expect(drawer.isOpen()).toBe(true);
  });

  it("destroy() takes the drawer off the screen", () => {
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
