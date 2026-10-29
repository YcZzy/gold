"use strict";
const evidence = require("./history-evidence.json");
const tenDays = 10 * 86400000;
const near = (actual, expected) =>
  Date.parse(actual + "T00:00:00Z") <=
  Date.parse(expected + "T00:00:00Z") + tenDays;
function coverage(rawRows, rows, asset, requestedStart) {
  const rawStart = String(rawRows[0][0]).slice(0, 10);
  const actualStart = String(rows[0][0]).slice(0, 10),
    actualEnd = String(rows[rows.length - 1][0]).slice(0, 10);
  const saved = evidence[asset.id];
  const known = asset.historyLegacy ? null :
    [asset.historyAvailableFrom, saved?.availableFrom].filter(Boolean).sort()[0];
  const confirmedShort = asset.historyRangeConfirmedFrom || saved?.shortHistoryFrom;
  let status = "unverified",
    basis = "short-provider-history",
    verified = false;
  if (near(rawStart, requestedStart)) {
    status = "complete";
    basis = "requested-start-covered";
    verified = true;
  } else if (confirmedShort && (!known || near(confirmedShort, known)) && confirmedShort > requestedStart && near(rawStart, confirmedShort)) {
      status = "limited";
      basis = "verified-short-history";
      verified = true;
  } else if (known) {
    if (!near(rawStart, known) || known <= requestedStart) {
      status = "truncated";
      basis = "earlier-history-verified";
    }
  }
  return {
    status,
    verified,
    basis,
    requestedStart,
    actualStart,
    actualEnd,
    rawStart,
    rawCount: rawRows.length,
    requestedLimit: 1500,
    ...(known ? { knownHistoryStart: known } : {}),
  };
}
function confirm(first, second) {
  if (
    first.coverage?.rawStart !== second.coverage?.rawStart ||
    first.coverage?.actualEnd !== second.coverage?.actualEnd
  )
    return false;
  const a = first.candles.at(-1),
    b = second.candles.at(-1);
  return Math.abs(a.c - b.c) <= Math.max(0.011, a.c * 0.0001);
}
module.exports = { coverage, confirm };
