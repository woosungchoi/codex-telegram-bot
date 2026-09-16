import test from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, nextOccurrence, occurrenceKey } from "../src/workspace/schedule.js";

const at = Date.parse("2026-09-12T00:00:00Z");
test("schedule validates inputs and preserves the chosen timezone", () => {
  const s = parseSchedule("once", "2026-09-13 09:30", "Asia/Seoul", at);
  assert.equal(nextOccurrence(s, at), Date.parse("2026-09-13T00:30:00Z"));
  assert.equal(nextOccurrence(s, s.at), null);
  for (const [kind, value] of [["once", "2026-02-30 09:30"], ["daily", "25:00"], ["weekly", "0 09:00"], ["monthly", "32 09:00"], ["interval", "0"], ["interval", "1.5"]]) {
    assert.throws(() => parseSchedule(kind, value, "Asia/Seoul", at));
  }
  assert.throws(() => parseSchedule("daily", "09:00", "invalid/timezone", at));
});
test("daily and weekly calendar schedules advance beyond the current occurrence", () => {
  const daily = parseSchedule("daily", "09:00", "Asia/Seoul", at);
  assert.equal(nextOccurrence(daily, at), at + 86400_000);
  const weekly = parseSchedule("weekly", "1 09:00", "Asia/Seoul", at);
  assert.equal(new Date(nextOccurrence(weekly, at)).toISOString(), "2026-09-14T00:00:00.000Z");
});
test("monthly day 31 skips months without that date", () => {
  const s = parseSchedule("monthly", "31 10:00", "UTC", at);
  assert.equal(new Date(nextOccurrence(s, at)).toISOString(), "2026-10-31T10:00:00.000Z");
});
test("DST gaps are skipped and repeated local times are not run twice", () => {
  const before = Date.parse("2026-03-08T05:00:00Z");
  const s = parseSchedule("daily", "02:30", "America/New_York", before);
  assert.equal(new Date(nextOccurrence(s, before)).toISOString(), "2026-03-09T06:30:00.000Z");
  const fall = parseSchedule("daily", "01:30", "America/New_York", before);
  const first = Date.parse("2026-11-01T05:30:00Z");
  assert.equal(new Date(nextOccurrence(fall, first, occurrenceKey(first, fall))).toISOString(), "2026-11-02T06:30:00.000Z");
});
test("interval has an explicit five-minute minimum", () => {
  assert.throws(() => parseSchedule("interval", "4", "UTC", at));
  assert.equal(nextOccurrence(parseSchedule("interval", "5", "UTC", at), at), at + 300_000);
});
