import { mappingDensityAt } from "./mapping-density";

// City tables straight out of docs/spec.md §4.5.1's dense list — Stockholm,
// Scandinavia, Germany, the US and Canada, the UK and Ireland, Australia
// and New Zealand — and a sparse spread across everywhere else, including
// near neighbours of dense regions and a handful of the sharpest borders
// the rings have to hold.
describe("mappingDensityAt", () => {
  const denseCities: Array<[city: string, lat: number, lon: number]> = [
    ["Stockholm", 59.33, 18.07],
    ["Gothenburg", 57.71, 11.97],
    ["Malmö", 55.6, 13.0],
    ["Kiruna", 67.86, 20.23],
    ["Oslo", 59.91, 10.75],
    ["Bergen", 60.39, 5.32],
    ["Tromsø", 69.65, 18.96],
    ["Copenhagen", 55.68, 12.57],
    ["Aalborg", 57.05, 9.92],
    ["Helsinki", 60.17, 24.94],
    ["Oulu", 65.01, 25.47],
    ["Lappeenranta", 61.06, 28.19],
    ["Berlin", 52.52, 13.4],
    ["Munich", 48.14, 11.58],
    ["Hamburg", 53.55, 9.99],
    ["Cologne", 50.94, 6.96],
    ["Aachen", 50.78, 6.08],
    ["Emden", 53.37, 7.21],
    ["Freiburg", 47.999, 7.85],
    ["Dresden", 51.05, 13.74],
    ["London", 51.51, -0.13],
    ["Manchester", 53.48, -2.24],
    ["Edinburgh", 55.95, -3.19],
    ["Glasgow", 55.86, -4.25],
    ["Cardiff", 51.48, -3.18],
    ["Inverness", 57.48, -4.22],
    ["Hastings", 50.85, 0.57],
    ["Dublin", 53.35, -6.26],
    ["Cork", 51.9, -8.47],
    ["Belfast", 54.6, -5.93],
    ["New York", 40.71, -74.01],
    ["Los Angeles", 34.05, -118.24],
    ["Chicago", 41.88, -87.63],
    ["Houston", 29.76, -95.37],
    ["Miami", 25.76, -80.19],
    ["Seattle", 47.61, -122.33],
    ["Denver", 39.74, -104.99],
    ["Boston", 42.36, -71.06],
    ["Buffalo", 42.89, -78.88],
    ["Minneapolis", 44.98, -93.27],
    ["San Diego", 32.72, -117.16],
    ["Yuma", 32.69, -114.63],
    ["Anchorage", 61.22, -149.9],
    ["Honolulu", 21.31, -157.86],
    ["Juneau", 58.3, -134.42],
    ["Vancouver", 49.28, -123.12],
    ["Whitehorse", 60.72, -135.05],
    ["Calgary", 51.05, -114.07],
    ["Winnipeg", 49.9, -97.14],
    ["Toronto", 43.65, -79.38],
    ["Montreal", 45.5, -73.57],
    ["Halifax", 44.65, -63.58],
    ["Iqaluit", 63.75, -68.52],
    ["St John's", 47.56, -52.71],
    ["Grand Bank", 47.1, -55.77],
    ["Sydney", -33.87, 151.21],
    ["Melbourne", -37.81, 144.96],
    ["Perth", -31.95, 115.86],
    ["Brisbane", -27.47, 153.03],
    ["Cairns", -16.92, 145.77],
    ["Hobart", -42.88, 147.33],
    ["Auckland", -36.85, 174.76],
    ["Wellington", -41.29, 174.78],
    ["Christchurch", -43.53, 172.64],
    ["Dunedin", -45.87, 170.5],
  ];

  it.each(denseCities)("reads %s as dense", (_city, lat, lon) => {
    expect(mappingDensityAt({ lat, lon })).toBe("dense");
  });

  const sparseCities: Array<[city: string, lat: number, lon: number]> = [
    ["Paris", 48.86, 2.35],
    ["Strasbourg", 48.58, 7.75],
    ["Basel", 47.56, 7.59],
    ["Salzburg", 47.8, 13.05],
    ["Prague", 50.09, 14.42],
    ["Vienna", 48.21, 16.37],
    ["Amsterdam", 52.37, 4.9],
    ["Enschede", 52.22, 6.9],
    ["Groningen", 53.22, 6.57],
    ["Delfzijl", 53.33, 6.93],
    ["Maastricht", 50.85, 5.69],
    ["Brussels", 50.85, 4.35],
    ["Zurich", 47.37, 8.54],
    ["Geneva", 46.2, 6.14],
    ["Warsaw", 52.23, 21.01],
    ["Szczecin", 53.43, 14.55],
    ["Tallinn", 59.44, 24.75],
    ["St Petersburg", 59.93, 30.36],
    ["Vyborg", 60.71, 28.75],
    ["Riga", 56.95, 24.11],
    ["Reykjavik", 64.15, -21.94],
    ["Nuuk", 64.18, -51.69],
    ["St-Pierre", 46.78, -56.18],
    ["Miquelon", 47.1, -56.38],
    ["Tijuana", 32.51, -117.04],
    ["Mexicali", 32.66, -115.47],
    ["Mexico City", 19.43, -99.13],
    ["Tokyo", 35.68, 139.69],
    ["Port Moresby", -9.44, 147.18],
    ["Jakarta", -6.21, 106.85],
    ["Cape Town", -33.92, 18.42],
    ["Nairobi", -1.29, 36.82],
    ["São Paulo", -23.55, -46.63],
    ["Buenos Aires", -34.6, -58.38],
    ["Lisbon", 38.72, -9.14],
    ["Madrid", 40.42, -3.7],
    ["Rome", 41.9, 12.5],
    ["Moscow", 55.76, 37.62],
    ["Beijing", 39.9, 116.41],
    ["mid-Atlantic ocean", 0, -30],
  ];

  it.each(sparseCities)("reads %s as sparse", (_city, lat, lon) => {
    expect(mappingDensityAt({ lat, lon })).toBe("sparse");
  });

  // Each of these is a place the module's own comments name as a deliberate
  // loss, not an oversight — named individually so a regression shows up as
  // exactly the scenario that broke, not a row number in a shared table.

  it("reads the Isle of Man as sparse: a Crown dependency between the GB and Ireland rings, on neither list", () => {
    expect(mappingDensityAt({ lat: 54.15, lon: -4.48 })).toBe("sparse");
  });

  it("reads the Chatham Islands as sparse: across the antimeridian from the New Zealand box, which no ring may straddle", () => {
    expect(mappingDensityAt({ lat: -43.95, lon: -176.55 })).toBe("sparse");
  });

  it("reads Resolute as sparse: the mainland ring's Arctic cap stops short of the high-Arctic archipelago", () => {
    expect(mappingDensityAt({ lat: 74.69, lon: -94.83 })).toBe("sparse");
  });
});
