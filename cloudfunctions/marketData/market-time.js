"use strict";
const formatters = new Map();
function parts(time, zone) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  return Object.fromEntries(
    formatters
      .get(zone)
      .formatToParts(new Date(time))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
}
function localLabel(time, zone, withClock = true) {
  const p = parts(time, zone);
  return (
    `${p.year}-${p.month}-${p.day}` +
    (withClock ? ` ${p.hour}:${p.minute}` : "")
  );
}
function localTime(value, zone, now = Date.now()) {
  let s = String(value || "").replace(/\//g, "-");
  if (/^\d{14}$/.test(s))
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12)}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    s,
  );
  if (!m) return null;
  const n = m.slice(1).map((x) => Number(x || 0));
  if (
    n[1] < 1 ||
    n[1] > 12 ||
    n[2] < 1 ||
    n[2] > 31 ||
    n[3] > 23 ||
    n[4] > 59 ||
    n[5] > 59
  )
    return null;
  const civil = Date.UTC(n[0], n[1] - 1, n[2], n[3], n[4], n[5]);
  let t = civil;
  for (let i = 0; i < 3; i++) {
    const p = parts(t, zone);
    const seen = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
    );
    t += civil - seen;
  }
  const p = parts(t, zone);
  if (
    +p.year !== n[0] ||
    +p.month !== n[1] ||
    +p.day !== n[2] ||
    +p.hour !== n[3]
  )
    return null;
  return t > Date.UTC(2000, 0, 1) && t <= now + 300000 ? t : null;
}
module.exports = { localTime, localLabel };
