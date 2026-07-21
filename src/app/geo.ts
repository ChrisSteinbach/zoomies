import type { LatLon } from "./types";

const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance in metres between two positions.
 *
 * A sphere is accurate enough here: over the tens of kilometres this app
 * searches, the difference from an ellipsoidal model is a few metres — well
 * inside the error of a phone GPS fix or of an OSM park's centroid.
 */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const latA = toRadians(a.lat);
  const latB = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
