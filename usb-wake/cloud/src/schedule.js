// Weekly wake schedules: { id, time: "HH:MM", days: [0-6, Sunday = 0], enabled }
// in the relay's TIMEZONE.

export const MAX_SCHEDULES = 8;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseSchedules(value) {
  if (!Array.isArray(value) || value.length > MAX_SCHEDULES) return null;
  const result = [];
  for (const item of value) {
    if (
      !item ||
      typeof item.time !== "string" ||
      !TIME.test(item.time) ||
      !Array.isArray(item.days) ||
      item.days.length < 1 ||
      item.days.length > 7 ||
      !item.days.every(
        (day) => Number.isInteger(day) && day >= 0 && day <= 6,
      ) ||
      typeof item.enabled !== "boolean"
    )
      return null;
    result.push({
      id:
        typeof item.id === "string" && /^[\w-]{1,40}$/.test(item.id)
          ? item.id
          : crypto.randomUUID(),
      time: item.time,
      days: [...new Set(item.days)].sort(),
      enabled: item.enabled,
    });
  }
  return result;
}

// Minutes east of UTC for `timeZone` at instant `at`.
function offsetMinutes(timeZone, at) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName").value;
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

function localDate(timeZone, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

// The first instant after `after` (ms) at which `schedule` fires, or null.
export function nextFire(schedule, after, timeZone) {
  if (!schedule.enabled) return null;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const today = localDate(timeZone, after);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(
      Date.UTC(today.year, today.month - 1, today.day + offset),
    );
    if (!schedule.days.includes(day.getUTCDay())) continue;
    const wall = Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hour,
      minute,
    );
    // Resolve the offset twice so a DST change between now and then is used.
    let at = wall - offsetMinutes(timeZone, wall) * 60000;
    at = wall - offsetMinutes(timeZone, at) * 60000;
    if (at > after) return at;
  }
  return null;
}
