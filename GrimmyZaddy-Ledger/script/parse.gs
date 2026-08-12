/**
 * 03_Parse — interpretation of Torn's raw log JSON (v2 `data` shape).
 *
 * All of it runs at REBUILD time, never at sync time. That separation is deliberate:
 * syncLogs stores the whole data object verbatim, so a wrong money_key is a one-line
 * LogTypeMap edit plus a rebuild rather than a re-download of years of history.
 */

/** Parse a raw row's stored JSON, safely. */
function parseRaw_(r) {
  try { return JSON.parse(r.raw || '{}'); } catch (e) { return {}; }
}

function moneyOf_(r, t) {
  var d = parseRaw_(r);

  if (t && t.moneyKey && d[t.moneyKey] !== undefined) return num_(d[t.moneyKey]);

  var v = firstKey_(d, MONEY_KEYS);
  if (v !== null) return num_(v);

  // No recognised money field, and deliberately no guessing. The old fallback took
  // the largest plausible number in the object and produced two wrong answers that
  // both looked entirely reasonable: unix timestamps as flight costs, and a Torn
  // user ID as 4,347,352 of property rent. Every log carries some number, so any
  // heuristic here eventually picks the wrong one. Return null (not zero) so a
  // genuinely $0 payout is not mistaken for an unparseable one — rebuild() flags
  // null and records a visible gap, which beats a plausible wrong figure.
  return null;
}
