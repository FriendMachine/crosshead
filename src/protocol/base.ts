export type Uuid = string;
export type Npub = string;
export type Hex = string;
export type Base64Url = string;
export type IsoDateString = string;

const RFC3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i;

// Published positive leap seconds through the current IERS/NIST table. A
// future leap second is not valid owner state until this reviewed contract is
// updated; accepting every June/December boundary would silently bless times
// that never occurred.
const RFC3339_LEAP_SECOND_UTC_DATES = new Set([
  "1972-06-30",
  "1972-12-31",
  "1973-12-31",
  "1974-12-31",
  "1975-12-31",
  "1976-12-31",
  "1977-12-31",
  "1978-12-31",
  "1979-12-31",
  "1981-06-30",
  "1982-06-30",
  "1983-06-30",
  "1985-06-30",
  "1987-12-31",
  "1989-12-31",
  "1990-12-31",
  "1992-06-30",
  "1993-06-30",
  "1994-06-30",
  "1995-12-31",
  "1997-06-30",
  "1998-12-31",
  "2005-12-31",
  "2008-12-31",
  "2012-06-30",
  "2015-06-30",
  "2016-12-31",
]);

const isLeapSecondAtUtcBoundary = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string
): boolean => {
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const magnitude = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
    offsetMinutes = zone[0] === "+" ? magnitude : -magnitude;
  }

  // Model the ordinary second immediately before :60, then normalize the
  // local offset. This also handles valid leap-second spellings whose local
  // minute/date differs from the UTC boundary.
  const localPreviousSecond = new Date(0);
  localPreviousSecond.setUTCFullYear(year, month - 1, day);
  localPreviousSecond.setUTCHours(hour, minute, 59, 0);
  const utcPreviousSecond = new Date(
    localPreviousSecond.getTime() - offsetMinutes * 60_000
  );
  const utcMonth = utcPreviousSecond.getUTCMonth() + 1;
  const utcDay = utcPreviousSecond.getUTCDate();
  const utcDate = [
    String(utcPreviousSecond.getUTCFullYear()).padStart(4, "0"),
    String(utcMonth).padStart(2, "0"),
    String(utcDay).padStart(2, "0"),
  ].join("-");
  return (
    utcPreviousSecond.getUTCHours() === 23 &&
    utcPreviousSecond.getUTCMinutes() === 59 &&
    utcPreviousSecond.getUTCSeconds() === 59 &&
    RFC3339_LEAP_SECOND_UTC_DATES.has(utcDate)
  );
};

/**
 * Accept a complete, calendar-valid RFC3339 timestamp. `Date.parse` alone is
 * intentionally insufficient: Node accepts ambiguous values such as `"0"`,
 * normalizes impossible dates such as February 30, and rejects RFC3339 leap
 * seconds. RFC3339 explicitly permits lowercase `t`/`z`, unbounded fractional
 * precision, and second 60 at a UTC June/December leap-second boundary.
 */
export const isRfc3339DateTime = (value: unknown): value is IsoDateString => {
  if (typeof value !== "string") return false;
  const match = RFC3339_DATE_TIME_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  ) {
    return false;
  }
  if (zone.toUpperCase() !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return (
    second < 60 ||
    isLeapSecondAtUtcBoundary(year, month, day, hour, minute, zone)
  );
};

export type Timestamped = {
  createdAt: Date;
  updatedAt: Date;
};

export type Status<T extends string> = T;
