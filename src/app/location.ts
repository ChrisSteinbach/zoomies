import type { LatLon } from "./types";

export type LocationErrorCode =
  "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT";

export interface LocationError {
  code: LocationErrorCode;
  message: string;
}

export interface LocationCallbacks {
  onPosition: (position: LatLon) => void;
  onError: (error: LocationError) => void;
}

/** Stop function returned by watchLocation. */
export type StopFn = () => void;

const ERROR_CODES: Record<number, LocationErrorCode> = {
  1: "PERMISSION_DENIED",
  2: "POSITION_UNAVAILABLE",
  3: "TIMEOUT",
};

/**
 * Watch the user's GPS position via the Geolocation API.
 * Returns a function that stops watching when called.
 *
 * `geo` is injectable so tests need no browser API.
 */
export function watchLocation(
  callbacks: LocationCallbacks,
  geo: Pick<
    Geolocation,
    "watchPosition" | "clearWatch"
  > = navigator.geolocation,
): StopFn {
  const watchId = geo.watchPosition(
    (pos) => {
      callbacks.onPosition({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      });
    },
    (err) => {
      callbacks.onError({
        code: ERROR_CODES[err.code] ?? "POSITION_UNAVAILABLE",
        message: err.message,
      });
    },
    {
      enableHighAccuracy: true,
      timeout: 30_000,
      maximumAge: 60_000,
    },
  );

  return () => geo.clearWatch(watchId);
}
