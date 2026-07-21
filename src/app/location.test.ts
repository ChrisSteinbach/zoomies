import { watchLocation } from "./location";
import type { LocationError } from "./location";
import type { LatLon } from "./types";

function fakeGeo() {
  let onSuccess: PositionCallback;
  let onError: PositionErrorCallback;
  const clearWatch = vi.fn();

  return {
    watchPosition(
      success: PositionCallback,
      error?: PositionErrorCallback | null,
    ) {
      onSuccess = success;
      onError = error!;
      return 1;
    },
    clearWatch,
    firePosition(lat: number, lon: number, accuracy?: number) {
      onSuccess({
        coords: { latitude: lat, longitude: lon, accuracy },
      } as GeolocationPosition);
    },
    fireError(code: number, message = "") {
      onError({ code, message } as GeolocationPositionError);
    },
  };
}

describe("watchLocation", () => {
  it("reports a fix as a plain lat/lon", () => {
    const geo = fakeGeo();
    const onPosition = vi.fn<(pos: LatLon, accuracyM: number | null) => void>();
    watchLocation({ onPosition, onError: vi.fn() }, geo);

    geo.firePosition(59.3293, 18.0686);

    // This device's coords carry no accuracy figure at all — the honest
    // reading is "does not say", not zero.
    expect(onPosition).toHaveBeenCalledWith(
      { lat: 59.3293, lon: 18.0686 },
      null,
    );
  });

  it("passes the device's own accuracy figure alongside a fix", () => {
    const geo = fakeGeo();
    const onPosition = vi.fn<(pos: LatLon, accuracyM: number | null) => void>();
    watchLocation({ onPosition, onError: vi.fn() }, geo);

    geo.firePosition(59.3293, 18.0686, 12.5);

    expect(onPosition).toHaveBeenCalledWith(
      { lat: 59.3293, lon: 18.0686 },
      12.5,
    );
  });

  it("reports a refused permission as PERMISSION_DENIED", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(1, "denied");

    expect(onError).toHaveBeenCalledWith({
      code: "PERMISSION_DENIED",
      message: "denied",
    });
  });

  it("reports a failed fix as POSITION_UNAVAILABLE", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(2, "unavailable");

    expect(onError).toHaveBeenCalledWith({
      code: "POSITION_UNAVAILABLE",
      message: "unavailable",
    });
  });

  it("reports a slow fix as TIMEOUT", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(3, "timed out");

    expect(onError).toHaveBeenCalledWith({
      code: "TIMEOUT",
      message: "timed out",
    });
  });

  it("treats an unrecognised error code as an unavailable position", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(99, "something weird");

    expect(onError).toHaveBeenCalledWith({
      code: "POSITION_UNAVAILABLE",
      message: "something weird",
    });
  });

  it("stops watching when the returned stop function is called", () => {
    const geo = fakeGeo();
    const stop = watchLocation({ onPosition: vi.fn(), onError: vi.fn() }, geo);

    stop();

    expect(geo.clearWatch).toHaveBeenCalledWith(1);
  });
});

describe("a browser with no Geolocation API", () => {
  it("reports it instead of throwing on the way up from the composition root", () => {
    const onError = vi.fn<(err: LocationError) => void>();

    expect(() =>
      watchLocation({ onPosition: vi.fn(), onError }, undefined),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith({
      code: "UNSUPPORTED",
      message: expect.stringContaining("Geolocation"),
    });
  });

  it("hands back a stop function that is safe to call", () => {
    const stop = watchLocation(
      { onPosition: vi.fn(), onError: vi.fn() },
      undefined,
    );

    expect(() => stop()).not.toThrow();
  });
});
