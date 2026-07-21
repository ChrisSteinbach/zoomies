import type { MonthDay, SeasonalRule } from "./types";

/**
 * English month names OSM's `dog:conditional` values use, full or
 * three-letter abbreviation, mapped to 1–12. This whitelist is the
 * parser's firewall: opening-hours syntax (`Su`, `Mo`, `PH`, a bare
 * `10:00-18:00`, …) and anything else that isn't an English month name
 * fails to match here and falls through to `unparsed`, instead of being
 * coerced into a date range it was never expressing.
 */
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Days in each month, index 0 = January, with February kept at 29.
 *
 * A seasonal rule has no year, so an inclusive February endpoint has to
 * accommodate a leap day that only exists every four years. Using 29
 * lets an explicit "Feb 29" parse (correct on a leap year) while a
 * concrete non-leap-year `Date` simply never reaches day 29 in February,
 * so {@link isBannedOn} treats it the same as the 28th without this table
 * needing to know which year it is.
 */
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `<month> [<day>] - <month> [<day>]`, whitespace-tolerant on both sides
 *  of the dash and between a month and its optional day. */
const DATE_RANGE = /^([A-Za-z]+)\s*(\d{1,2})?\s*-\s*([A-Za-z]+)\s*(\d{1,2})?$/;

/**
 * Splits an OSM conditional-restriction value into its `;`-separated
 * clauses, except a `;` inside parentheses does not end a clause.
 *
 * This grammar never itself produces a parenthesized `;` — the only
 * condition shape it recognises is a plain date range — but a clause this
 * parser doesn't understand (an opening_hours-style condition, say) may
 * still use one, and letting it fracture that clause in two would turn one
 * unparsed clause into two, or worse, accidentally reassemble into
 * something that looks parseable.
 */
function splitClauses(value: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === ";" && depth === 0) {
      clauses.push(value.slice(start, i));
      start = i + 1;
    }
  }
  clauses.push(value.slice(start));
  return clauses;
}

/**
 * Strips one surrounding pair of parentheses, only when that pair wraps
 * the entire string — not `(a)(b)`, not a `(` that closes before the
 * string ends. "One optional surrounding pair" means exactly that, not
 * "there are parentheses somewhere in here".
 */
function stripOuterParens(s: string): string {
  if (!s.startsWith("(") || !s.endsWith(")")) return s;

  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") {
      depth++;
    } else if (s[i] === ")") {
      depth--;
      if (depth === 0 && i !== s.length - 1) return s;
    }
  }
  return s.slice(1, -1).trim();
}

function parseMonthDayEndpoint(
  monthToken: string,
  dayToken: string | undefined,
  defaultToLastDay: boolean,
): MonthDay | null {
  const month = MONTHS[monthToken.toLowerCase()];
  if (month === undefined) return null;

  if (dayToken === undefined) {
    return { month, day: defaultToLastDay ? MONTH_LENGTHS[month - 1] : 1 };
  }
  const day = Number(dayToken);
  if (day < 1 || day > MONTH_LENGTHS[month - 1]) return null;
  return { month, day };
}

function parseDateRange(
  condition: string,
): { from: MonthDay; to: MonthDay } | null {
  const match = DATE_RANGE.exec(condition);
  if (!match) return null;

  const [, fromMonth, fromDay, toMonth, toDay] = match;
  const from = parseMonthDayEndpoint(fromMonth, fromDay, false);
  const to = parseMonthDayEndpoint(toMonth, toDay, true);
  if (!from || !to) return null;
  return { from, to };
}

/**
 * A clause is a recognised ban when its restriction (the text before `@`)
 * is exactly "no", and its condition (the text after, one optional pair of
 * parens stripped) is a date range this grammar understands. Anything else
 * — "yes", "leashed", a weekday or time-of-day condition, a single date, a
 * bare "no" with nothing after it, garbage — is not a ban clause, and the
 * caller tries the next one.
 */
function parseBanClause(clause: string): SeasonalRule | null {
  const at = clause.indexOf("@");
  if (at === -1) return null;

  const restriction = clause.slice(0, at).trim();
  if (restriction.toLowerCase() !== "no") return null;

  const condition = stripOuterParens(clause.slice(at + 1).trim());
  const range = parseDateRange(condition);
  if (!range) return null;
  return { kind: "ban", from: range.from, to: range.to };
}

/**
 * Parses an OSM `dog:conditional` tag value into the one shape this app
 * acts on: an annual date-range ban.
 *
 * `dog:conditional` reuses OSM's general conditional-restriction grammar
 * (`restriction @ condition; restriction @ condition; …`), which also
 * expresses weekday and time-of-day conditions, opening-hours syntax, and
 * restrictions other than "no". This parser deliberately recognises only
 * the ban-by-date-range shape and calls everything else unparsed, because
 * a machine-readable seasonal ban is the one piece of legality information
 * this app can act on (docs/spec.md §4.5.3, dogs banned from Stockholm
 * beaches roughly 1 June – 31 August). Getting cute with the grammar risks
 * parsing something that isn't actually a date range and reporting a false
 * window — worse than not parsing it, because a *wrong* answer here can
 * send someone to a beach where their dog is illegal, whereas "unparsed"
 * at least says "go check the sign".
 *
 * The first clause that parses as a ban wins; every other clause (earlier
 * or later, "yes", "leashed", a second ban) is ignored once one is found.
 * Never throws — a value this grammar doesn't recognise is
 * `{ kind: "unparsed" }`, not an exception the caller has to guard against.
 */
export function parseDogConditional(value: string): SeasonalRule {
  for (const clause of splitClauses(value)) {
    const rule = parseBanClause(clause);
    if (rule) return rule;
  }
  return { kind: "unparsed" };
}

function compareMonthDay(a: MonthDay, b: MonthDay): number {
  return a.month !== b.month ? a.month - b.month : a.day - b.day;
}

/**
 * Whether a {@link SeasonalRule} bans dogs on the given date.
 *
 * `unparsed` always answers `false` — never assert a ban the app didn't
 * actually read. The "verify signage on site" caption (docs/spec.md
 * §4.5.3) is what carries the warning for that case; this function
 * guessing would just be a second, less visible way of getting it wrong.
 *
 * A `ban` where `from` sorts after `to` wraps the year end (e.g. November
 * to March): banned when `on` is on or after `from`, OR on or before `to`.
 * Otherwise it's a plain range: banned when `on` is on or after `from` AND
 * on or before `to`, both endpoints inclusive.
 *
 * Reads `on`'s LOCAL month/date (`getMonth`/`getDate`), not UTC: the
 * question is whether the ban applies where the user and the beach both
 * are, right now, and that place is the device's own timezone.
 */
export function isBannedOn(rule: SeasonalRule, on: Date): boolean {
  if (rule.kind === "unparsed") return false;

  const today: MonthDay = { month: on.getMonth() + 1, day: on.getDate() };
  const wraps = compareMonthDay(rule.from, rule.to) > 0;

  if (wraps) {
    return (
      compareMonthDay(today, rule.from) >= 0 ||
      compareMonthDay(today, rule.to) <= 0
    );
  }
  return (
    compareMonthDay(today, rule.from) >= 0 &&
    compareMonthDay(today, rule.to) <= 0
  );
}
