import { describe, expect, it } from "vitest";

import { isRfc3339DateTime } from "../../src/protocol/base";

describe("domain timestamp validation", () => {
  it("accepts complete calendar-valid RFC3339 date-times", () => {
    for (const value of [
      "2026-08-24T11:30:00Z",
      "2026-08-24T11:30:00.000Z",
      "2026-08-24T11:30:00.123456789Z",
      "2026-08-24t11:30:00.123456789012345678z",
      "2026-08-24T07:30:00-04:00",
      "2024-02-29T23:59:59+00:00",
      "2016-12-31T23:59:60Z",
      "2017-01-01T00:59:60+01:00",
    ]) {
      expect(isRfc3339DateTime(value), value).toBe(true);
    }
  });

  it("rejects ambiguous, incomplete, and impossible date-times", () => {
    for (const value of [
      "0",
      "2026-08-24",
      "2026-08-24T11:30:00",
      "Mon, 24 Aug 2026 11:30:00 GMT",
      "2026-02-29T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-08-24T24:00:00Z",
      "2026-08-24T11:60:00Z",
      "2026-08-24T11:30:61Z",
      "2016-12-30T23:59:60Z",
      "2016-12-31T23:58:60Z",
      "2016-06-30T23:59:60Z",
      "1999-12-31T23:59:60Z",
      "2026-06-30T23:59:60Z",
      "2026-07-01T00:59:60+01:00",
      "2026-08-24T11:30:00+24:00",
    ]) {
      expect(isRfc3339DateTime(value), value).toBe(false);
    }
  });
});
