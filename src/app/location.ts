import type { LatLon } from "./types";

export type LocationErrorCode =
  | "PERMISSION_DENIED"
  | "POSITION_UNAVAILABLE"
  | "TIMEOUT"
  /**
   * The browser will not offer the Geolocation API at all.
   *
   * Almost always a secure-context failure: the API is unavailable over plain
   * `http://`, so the browser never even shows a permission prompt. `localhost`
   * is exempt, which is why this is invisible on a desktop and appears on the
   * phone the app is actually for. Distinct from a refusal, because the remedy
   * is completely different — and telling someone to check their browser
   * settings when the page itself is the problem sends them nowhere.
   */
  | "UNSUPPORTED";

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

/** The slice of the Geolocation API this app uses. */
export type GeolocationSource = Pick<
  Geolocation,
  "watchPosition" | "clearWatch"
>;

/**
 * Watch the user's GPS position via the Geolocation API.
 * Returns a function that stops watching when called.
 *
 * `geo` is injectable so tests need no browser API.
 *
 * A browser that offers no Geolocation at all reports `UNSUPPORTED` through
 * the usual error path rather than throwing. That case is real — an insecure
 * origin — and it must land the app in a state with a way forward, not in an
 * exception on the way up from the composition root.
 */
export function watchLocation(
  callbacks: LocationCallbacks,
  geo: GeolocationSource | undefined = navigator.geolocation,
): StopFn {
  if (typeof geo?.watchPosition !== "function") {
    callbacks.onError({
      code: "UNSUPPORTED",
      message: "This browser is not offering the Geolocation API",
    });
    return () => {};
  }

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
