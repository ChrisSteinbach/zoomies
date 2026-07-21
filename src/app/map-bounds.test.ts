// @vitest-environment jsdom

import L from "leaflet";
import { worldZoomBounds } from "./map-bounds";

/**
 * jsdom lays nothing out, so an element's size is whatever we say it is.
 * Leaflet reads `clientWidth`/`clientHeight` to decide how far out the world
 * still fills the viewport, which is exactly the input these tests vary.
 */
function sizedMapElement(width: number, height: number) {
  const element = document.createElement("div");
  let size = { width, height };
  Object.defineProperty(element, "clientWidth", { get: () => size.width });
  Object.defineProperty(element, "clientHeight", { get: () => size.height });
  document.body.appendChild(element);
  return {
    element,
    resizeTo(newWidth: number, newHeight: number) {
      size = { width: newWidth, height: newHeight };
    },
  };
}

describe("worldZoomBounds", () => {
  it("bounds the map to a single copy of the world", () => {
    const { maxBounds } = worldZoomBounds().mapOptions;

    expect([
      maxBounds.getSouth(),
      maxBounds.getWest(),
      maxBounds.getNorth(),
      maxBounds.getEast(),
    ]).toEqual([-90, -180, 90, 180]);
  });

  it("holds the map hard against the edge of the world rather than springing back", () => {
    expect(worldZoomBounds().mapOptions.maxBoundsViscosity).toBe(1.0);
  });

  it("stops tiles repeating past the antimeridian", () => {
    expect(worldZoomBounds().tileOptions.noWrap).toBe(true);
  });

  it("stops the user zooming out past the point where the world fills the map", () => {
    const { element } = sizedMapElement(800, 600);
    const map = L.map(element).setView([30, 10], 5);

    worldZoomBounds().install(map);

    // 800x600 px needs zoom 2 before one world covers it; below that the
    // planet would float in empty space.
    expect(map.getMinZoom()).toBe(2);
    map.remove();
  });

  it("recomputes the zoom floor when the map gets bigger", () => {
    const { element, resizeTo } = sizedMapElement(800, 600);
    const map = L.map(element).setView([30, 10], 5);
    worldZoomBounds().install(map);

    resizeTo(2000, 1500);
    map.invalidateSize();

    expect(map.getMinZoom()).toBe(3);
    map.remove();
  });

  it("lets the user zoom back out when the map gets smaller again", () => {
    const { element, resizeTo } = sizedMapElement(2000, 1500);
    const map = L.map(element).setView([30, 10], 5);
    worldZoomBounds().install(map);

    resizeTo(300, 400);
    map.invalidateSize();

    expect(map.getMinZoom()).toBe(1);
    map.remove();
  });

  it("stops recomputing once the returned cleanup has run", () => {
    const { element, resizeTo } = sizedMapElement(800, 600);
    const map = L.map(element).setView([30, 10], 5);
    const stop = worldZoomBounds().install(map);

    stop();
    resizeTo(2000, 1500);
    map.invalidateSize();

    expect(map.getMinZoom()).toBe(2);
    map.remove();
  });
});
