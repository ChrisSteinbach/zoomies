import { haversineMeters } from "./geo";

describe("haversineMeters", () => {
  it("reports no distance between a position and itself", () => {
    const tCentralen = { lat: 59.3307, lon: 18.0596 };

    expect(haversineMeters(tCentralen, tCentralen)).toBe(0);
  });

  it("measures Stockholm T-Centralen to Globen as roughly 4.3 km", () => {
    const tCentralen = { lat: 59.3307, lon: 18.0596 };
    const globen = { lat: 59.2937, lon: 18.081 };

    const meters = haversineMeters(tCentralen, globen);

    expect(meters).toBeGreaterThan(4200);
    expect(meters).toBeLessThan(4500);
  });

  it("measures the same distance in either direction", () => {
    const tCentralen = { lat: 59.3307, lon: 18.0596 };
    const globen = { lat: 59.2937, lon: 18.081 };

    expect(haversineMeters(globen, tCentralen)).toBeCloseTo(
      haversineMeters(tCentralen, globen),
      9,
    );
  });
});
