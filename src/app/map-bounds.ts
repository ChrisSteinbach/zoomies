import L from "leaflet";

/**
 * Keeps a Leaflet map inside one copy of the world.
 *
 * Without this, panning east past the antimeridian scrolls into a second
 * (third, fourth…) rendering of the planet, and zooming out far enough tiles
 * the world in miniature. Both are disorienting when the map is being used to
 * say "I am *here*".
 *
 * The pieces are handed back rather than applied, because two of them have to
 * be passed to constructors (`L.map`, `L.tileLayer`) and only the third can be
 * installed on a live map.
 */
export interface WorldBoundsSetup {
  /** Spread into the options given to `L.map()`. */
  mapOptions: { maxBounds: L.LatLngBounds; maxBoundsViscosity: number };
  /** Spread into the options given to `L.tileLayer()`. */
  tileOptions: { noWrap: boolean };
  /**
   * Applies the zoom floor to a live map and keeps it current as the map
   * resizes. Returns a function that stops the updates — call it before
   * `map.remove()`.
   */
  install(map: L.Map): () => void;
}

export function worldZoomBounds(): WorldBoundsSetup {
  const bounds = L.latLngBounds([-90, -180], [90, 180]);

  return {
    // Viscosity 1.0 makes the edge of the world a hard wall rather than a
    // rubber band that snaps back.
    mapOptions: { maxBounds: bounds, maxBoundsViscosity: 1.0 },
    tileOptions: { noWrap: true },

    install(map) {
      function updateMinZoom() {
        // The floor is "zoomed out far enough that the world still covers the
        // viewport" — which depends on the viewport, so it is recomputed on
        // every resize (phone rotation, desktop window drag).
        //
        // `getBoundsZoom` never answers below the map's *current* minimum, so
        // a floor computed for a large viewport would stick after the viewport
        // shrank, leaving the user unable to zoom back out. Drop the floor
        // before measuring.
        map.setMinZoom(0);
        map.setMinZoom(map.getBoundsZoom(bounds, true));
      }

      updateMinZoom();
      map.on("resize", updateMinZoom);
      return () => map.off("resize", updateMinZoom);
    },
  };
}
