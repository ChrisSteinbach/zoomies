import { formatDistance, directionsUrl } from "./format";

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8)";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64)";

describe("formatDistance", () => {
  it("gives whole metres for anything under a kilometre", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(350)).toBe("350 m");
    expect(formatDistance(999)).toBe("999 m");
  });

  it("gives one decimal place between 1 and 10 km", () => {
    expect(formatDistance(1000)).toBe("1.0 km");
    expect(formatDistance(1500)).toBe("1.5 km");
  });

  it("drops the decimal once the walk is over 10 km", () => {
    expect(formatDistance(10_000)).toBe("10 km");
    expect(formatDistance(12_345)).toBe("12 km");
  });
});

describe("directionsUrl", () => {
  const tantolunden = { lat: 59.3123, lon: 18.0421 };
  const home = { lat: 59.3293, lon: 18.0686 };

  it("opens Apple Maps on an iPhone", () => {
    const url = directionsUrl(tantolunden, null, IOS);

    expect(url).toBe("https://maps.apple.com/?daddr=59.3123,18.0421");
  });

  it("opens the geo: scheme on Android, letting the maps app start from the live fix", () => {
    const url = directionsUrl(tantolunden, null, ANDROID);

    expect(url).toBe("geo:59.3123,18.0421?q=59.3123,18.0421");
  });

  it("opens Google Maps on a desktop browser", () => {
    const url = directionsUrl(tantolunden, null, DESKTOP);

    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=59.3123,18.0421",
    );
  });

  it("routes from a picked position when one is given", () => {
    const url = directionsUrl(tantolunden, home, DESKTOP);

    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=59.3123,18.0421&origin=59.3293,18.0686",
    );
  });

  it("routes from a picked position on iOS too", () => {
    const url = directionsUrl(tantolunden, home, IOS);

    expect(url).toBe(
      "https://maps.apple.com/?daddr=59.3123,18.0421&saddr=59.3293,18.0686",
    );
  });

  it("leaves the origin to the maps app when none is given", () => {
    const url = directionsUrl(tantolunden, null, DESKTOP);

    expect(url).not.toContain("origin");
    expect(url).not.toContain("saddr");
  });
});
