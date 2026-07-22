// The red location pin, ported from tour-guide — hand-made there, shared
// here, and kept structurally identical to its source (tour-guide's
// map-icons.ts) so the two stay diffable if the pin machinery ever moves into
// a shared library (zoomies-el7).
//
// The red teardrop means one thing across the app: the search origin. The
// picker plants it on the spot being chosen, and the results map stands it
// where the user is — "where you are" and "where you said you are" are the
// same symbol on purpose.
//
// Drawn as an inline data URI rather than a file, for the reason the result
// pins in spot-map.ts give: Leaflet resolves file-based marker images
// relative to wherever its stylesheet ended up, which survives `npm run dev`
// and then 404s in a hashed production build.

import L from "leaflet";

const PIN_VIEWBOX = "117 52 278 388";

const PIN_SHELL_PATH =
  "M256,440 C256,440 395,272 395,185 C395,108 333,52 256,52 C179,52 117,108 117,185 C117,272 256,440 256,440Z";

const SHADOW_FILTER = `<filter id="s" x="-10%" y="-5%" width="120%" height="115%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.3"/></filter>`;

const LOCATION_PIN_SIZE: [number, number] = [30, 42];

function encodeSvg(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function pinSvg(contents: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${PIN_VIEWBOX}"><defs>${SHADOW_FILTER}</defs>${contents}</svg>`;
}

function makePinIcon(
  contents: string,
  w: number,
  h: number,
  className = "",
): L.Icon {
  return L.icon({
    iconUrl: encodeSvg(pinSvg(contents)),
    iconSize: [w, h],
    // Bottom centre — the tip of the teardrop is the place.
    iconAnchor: [w / 2, h],
    tooltipAnchor: [0, -h],
    className,
  });
}

/**
 * The red pin.
 *
 * A builder rather than a constant — the one deviation from tour-guide's
 * shape — because a caller may need a class of its own on the marker
 * (spot-map keeps its you-are-here marker untappable through one), and that
 * class name is the caller's business, not this module's.
 */
export function locationPinIcon(className?: string): L.Icon {
  const contents = `<path d="${PIN_SHELL_PATH}" fill="#e84033" filter="url(#s)"/><circle cx="256" cy="185" r="56" fill="#fff"/>`;
  return makePinIcon(contents, ...LOCATION_PIN_SIZE, className);
}
