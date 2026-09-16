import { createMessageFormatter, LocalizedError } from "../i18n.js";
// Calendar schedules use the saved IANA timezone, including daylight-saving changes.
// A repeated local minute fires once; a missing local minute is skipped.
function partsAt(ms, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(ms).map((p) => [p.type, p.value]));
}

function wallKey(ms, zone) {
  const p = partsAt(ms, zone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function localInstant(value, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new LocalizedError("errors.useYYYYMMDDHHMM");
  const [, y, mo, d, h, mi] = m.map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 5; i++) {
    const p = partsAt(guess, zone);
    const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    const shift = Date.UTC(y, mo - 1, d, h, mi) - actual;
    if (!shift) break;
    guess += shift;
  }
  if (wallKey(guess, zone) !== value) throw new LocalizedError("errors.thisLocalDateTimeDoesNotExist");
  return guess;
}

export function parseSchedule(kind, value, timeZone, now = Date.now()) {
  partsAt(now, timeZone); // Validate timezone before saving.
  const raw = String(value).trim();
  const result = { kind, timeZone };
  if (kind === "interval") {
    if (!/^\d+$/.test(raw) || +raw < 5 || +raw > 525600) throw new LocalizedError("errors.interval5525600Minutes");
    result.minutes = +raw;
  } else if (kind === "once") {
    result.at = localInstant(raw, timeZone);
    if (result.at <= now) throw new LocalizedError("errors.chooseAFutureDateTime");
  } else {
    const m = /^(?:(\d{1,2})\s+)?([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
    if (!m || !["daily", "weekly", "monthly"].includes(kind)) throw new LocalizedError("errors.useHHMMOrADayNumberFollowedBy");
    result.time = `${m[2]}:${m[3]}`;
    if (kind === "daily" && m[1]) throw new LocalizedError("errors.dailyTimeHHMM");
    if (kind !== "daily") {
      result.day = Number(m[1]);
      if (!Number.isInteger(result.day) || result.day < 1 || result.day > (kind === "weekly" ? 7 : 31)) throw new LocalizedError("errors.weeklyDay17MonSunMonthlyDay1");
    }
  }
  return result;
}

export function nextOccurrence(schedule, after = Date.now(), lastLocalKey = "") {
  if (schedule.kind === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.kind === "interval") return after + schedule.minutes * 60_000;
  const p = partsAt(after, schedule.timeZone);
  const date = Date.UTC(+p.year, +p.month - 1, +p.day);
  // At most 63 local dates, rather than an expensive minute-by-minute scan.
  for (let i = 0; i < 63; i++) {
    const day = new Date(date + i * 86400_000);
    if (schedule.kind === "weekly" && (day.getUTCDay() || 7) !== schedule.day) continue;
    if (schedule.kind === "monthly" && day.getUTCDate() !== schedule.day) continue;
    const key = `${day.toISOString().slice(0, 10)} ${schedule.time}`;
    if (key === lastLocalKey) continue;
    try {
      const at = localInstant(key, schedule.timeZone);
      if (at > after) return at;
    } catch { /* DST gap: skip this local occurrence. */ }
  }
  throw new LocalizedError("errors.noUpcomingOccurrenceFound");
}

export function scheduleLabel(s, text) {
  const msg = createMessageFormatter(text);
  const value = s.kind === "interval" ? msg("workspace.intervalMinutes", { count: s.minutes }) : s.kind === "once"
    ? wallKey(s.at, s.timeZone) : `${s.day ? `${s.day} ` : ""}${s.time}`;
  return `${msg(`workspace.${s.kind}`)} · ${value} · ${s.timeZone}`;
}

export function occurrenceKey(at, schedule) {
  return schedule.kind === "interval" ? String(at) : wallKey(at, schedule.timeZone);
}
