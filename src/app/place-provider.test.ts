import { PlaceProviderError } from "./place-provider";

describe("PlaceProviderError", () => {
  it("is catchable as an ordinary Error", () => {
    const error = new PlaceProviderError("timeout", "Overpass took too long");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Overpass took too long");
  });

  it("offers a retry for a request that timed out", () => {
    const error = new PlaceProviderError("timeout", "took too long");

    expect(error.retryable).toBe(true);
  });

  it("offers a retry when the device is offline", () => {
    const error = new PlaceProviderError("network-unavailable", "offline");

    expect(error.retryable).toBe(true);
  });

  it("offers a retry when we are asking too often", () => {
    const error = new PlaceProviderError("rate-limited", "slow down", {
      status: 429,
      retryAfterMs: 30_000,
    });

    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("offers a retry when the server faulted", () => {
    const error = new PlaceProviderError("http-error", "bad gateway", {
      status: 502,
    });

    expect(error.retryable).toBe(true);
  });

  it("does not offer a retry when we sent a request the server rejected", () => {
    const error = new PlaceProviderError("http-error", "not acceptable", {
      status: 406,
    });

    expect(error.retryable).toBe(false);
  });

  it("does not offer a retry for a response it could not parse", () => {
    const error = new PlaceProviderError("malformed-response", "not JSON");

    expect(error.retryable).toBe(false);
  });

  it("keeps the underlying failure for diagnosis", () => {
    const cause = new TypeError("Failed to fetch");

    const error = new PlaceProviderError("network-unavailable", "offline", {
      cause,
    });

    expect(error.cause).toBe(cause);
  });
});
