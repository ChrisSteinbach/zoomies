import type { LatLon, MonthDay } from "./types";

/** Human-readable distance: metres below 1 km, km above. */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/** January first, so `month - 1` indexes it. */
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * One end of a seasonal window, in words: `"1 Jun"`, `"31 Aug"`.
 *
 * No year, because a {@link MonthDay} has none — the rules these dates come
 * from recur every summer (docs/spec.md §4.5.3), and printing a year would
 * invite the reader to work out whether it had already gone by.
 *
 * Abbreviated rather than spelled out: these sit in a caption beside a name
 * and a distance on a phone screen, and "1 June – 31 August" wraps the line
 * that a dog ban is written on. Formatted here rather than through
 * `Intl.DateTimeFormat` because there is no date to format — a month and a day
 * with no year is not a moment, and manufacturing one to print it would make
 * the answer depend on the device's calendar and locale.
 */
export function formatMonthDay({ month, day }: MonthDay): string {
  return `${day} ${MONTH_NAMES[month - 1]}`;
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
