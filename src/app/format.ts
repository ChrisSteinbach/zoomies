import type { LatLon } from "./types";

/** Human-readable distance: metres below 1 km, km above. */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/**
 * A directions link for the platform the user is on.
 *
 * We deep-link into the platform's maps app rather than building routing
 * ourselves — the spec is firm on that (docs/spec.md §3, §6).
 *
 * `origin` is optional on purpose. Omit it when the user is standing where
 * the app thinks they are: the maps app then routes from its own live fix,
 * which is fresher than ours. Pass it when the position was picked manually,
 * because there "current location" is precisely not what the user meant.
 *
 * `userAgent` is a parameter rather than a direct `navigator` read so the
 * platform branches can be tested.
 */
export function directionsUrl(
  destination: LatLon,
  origin?: LatLon | null,
  userAgent: string = navigator.userAgent,
): string {
  const { lat, lon } = destination;

  if (/iPad|iPhone|iPod/.test(userAgent)) {
    const base = `https://maps.apple.com/?daddr=${lat},${lon}`;
    return origin ? `${base}&saddr=${origin.lat},${origin.lon}` : base;
  }
  if (/Android/.test(userAgent) && !origin) {
    return `geo:${lat},${lon}?q=${lat},${lon}`;
  }
  // Google Maps for desktop, and for Android when we have an origin to pin.
  const base = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  return origin ? `${base}&origin=${origin.lat},${origin.lon}` : base;
}
