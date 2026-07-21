import { parseDogConditional, isBannedOn } from "./dog-conditional";

describe("parseDogConditional", () => {
  it("parses the canonical Stockholm summer beach ban", () => {
    const rule = parseDogConditional("no @ (Jun 1-Aug 31)");

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("accepts the condition without surrounding parentheses", () => {
    const rule = parseDogConditional("no @ Jun 1-Aug 31");

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("is case-insensitive on the restriction and the month names", () => {
    const rule = parseDogConditional("NO @ jun 1 - aug 31");

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("accepts full month names as well as three-letter abbreviations", () => {
    const rule = parseDogConditional("no @ (June 1 - August 31)");

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("tolerates extra whitespace throughout the clause", () => {
    const rule = parseDogConditional("no   @   (Jun   1-Aug   31)");

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("defaults a month-only range to the first and last day of those months", () => {
    const rule = parseDogConditional("no @ (Jun-Aug)");

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("defaults a month-only February endpoint to day 29, not 28", () => {
    const rule = parseDogConditional("no @ (Jan-Feb)");

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 1, day: 1 },
      to: { month: 2, day: 29 },
    });
  });

  it("uses a ban clause and ignores a later non-ban clause", () => {
    const rule = parseDogConditional(
      "no @ (Jun 1-Aug 31); yes @ (Sep 1-May 31)",
    );

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("lets the first ban clause win over a second, later ban clause", () => {
    const rule = parseDogConditional(
      "no @ (Jun 1-Aug 31); no @ (Nov 1-Mar 31)",
    );

    expect(rule).toEqual({
      kind: "ban",
      from: { month: 6, day: 1 },
      to: { month: 8, day: 31 },
    });
  });

  it("does not treat a non-'no' restriction as a ban", () => {
    const rule = parseDogConditional("leashed @ (Jun 1-Aug 31)");

    expect(rule).toEqual({ kind: "unparsed" });
  });

  it("does not mistake a time-of-day condition for a date range (the opening-hours trap)", () => {
    const rule = parseDogConditional("no @ (Su 10:00-18:00)");

    expect(rule).toEqual({ kind: "unparsed" });
  });

  it("does not treat a single date with no range as a ban", () => {
    const rule = parseDogConditional("no @ (Dec 24)");

    expect(rule).toEqual({ kind: "unparsed" });
  });

  it("treats a bare restriction with no condition as unparsed", () => {
    const rule = parseDogConditional("no");

    expect(rule).toEqual({ kind: "unparsed" });
  });

  it("treats an empty or whitespace-only value as unparsed", () => {
    expect(parseDogConditional("")).toEqual({ kind: "unparsed" });
    expect(parseDogConditional("   ")).toEqual({ kind: "unparsed" });
  });

  it("treats arbitrary garbage as unparsed", () => {
    const rule = parseDogConditional(
      "definitely not a conditional restriction",
    );

    expect(rule).toEqual({ kind: "unparsed" });
  });

  it("rejects a day that does not exist in its month", () => {
    const rule = parseDogConditional("no @ (Jun 31-Aug 31)");

    expect(rule).toEqual({ kind: "unparsed" });
  });
});

describe("isBannedOn", () => {
  const summerBan = {
    kind: "ban" as const,
    from: { month: 6, day: 1 },
    to: { month: 8, day: 31 },
  };

  it("is banned for a date inside the range", () => {
    expect(isBannedOn(summerBan, new Date(2026, 6, 15))).toBe(true);
  });

  it("is not banned for a date outside the range", () => {
    expect(isBannedOn(summerBan, new Date(2026, 0, 1))).toBe(false);
  });

  it("is banned on both endpoints, inclusive", () => {
    expect(isBannedOn(summerBan, new Date(2026, 5, 1))).toBe(true);
    expect(isBannedOn(summerBan, new Date(2026, 7, 31))).toBe(true);
  });

  it("is banned in the wrapped part of a range that crosses the year end", () => {
    const winterBan = {
      kind: "ban" as const,
      from: { month: 11, day: 1 },
      to: { month: 3, day: 31 },
    };

    expect(isBannedOn(winterBan, new Date(2026, 0, 15))).toBe(true);
  });

  it("is not banned outside a range that crosses the year end", () => {
    const winterBan = {
      kind: "ban" as const,
      from: { month: 11, day: 1 },
      to: { month: 3, day: 31 },
    };

    expect(isBannedOn(winterBan, new Date(2026, 5, 15))).toBe(false);
  });

  it("is never banned when the rule could not be parsed", () => {
    expect(isBannedOn({ kind: "unparsed" }, new Date(2026, 6, 15))).toBe(false);
  });
});
