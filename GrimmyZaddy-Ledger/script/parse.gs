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

  if (t && t.moneyKey) {
    var v = moneyExpr_(d, t.moneyKey);
    if (v !== null) return v;
    // A DERIVED expression (/2, a-b, a?b) encodes the exact shape of one log
    // type, so a missing field means the row does not match the type's known
    // shape and must NOT be re-guessed by firstKey_ — a casino loss would
    // otherwise fall back to bet_amount and be booked as a WIN. Plain field
    // names keep the fallback for compatibility with older maps.
    if (/[\/?-]/.test(t.moneyKey)) return null;
  }

  var v2 = firstKey_(d, MONEY_KEYS);
  if (v2 !== null) return num_(v2);

  // Compacted rows carry no raw JSON: their money was resolved and frozen into
  // the money column at compaction time (never null there), so it is
  // authoritative. Only rows WITH raw JSON get the no-guessing treatment below.
  if (!r.raw) return num_(r.money);

  // No recognised money field, and deliberately no guessing. The old fallback took
  // the largest plausible number in the object and produced two wrong answers that
  // both looked entirely reasonable: unix timestamps as flight costs, and a Torn
  // user ID as 4,347,352 of property rent. Every log carries some number, so any
  // heuristic here eventually picks the wrong one. Return null (not zero) so a
  // genuinely $0 payout is not mistaken for an unparseable one — rebuild() flags
  // null and records a visible gap, which beats a plausible wrong figure.
  return null;
}

/**
 * Resolve a LogTypeMap money_key against a log's data object. Beyond a plain
 * field name, three tiny derived forms cover log types whose data carries no
 * directly matchable money field (the amount must be computed — see
 * DERIVED_MONEY_KEYS in config.gs for which types need this and why):
 *   'field'       -> data.field
 *   'field/2'     -> floor(data.field / 2)   (high-low cash in half pays half the pot)
 *   'field-other' -> data.field - data.other (stock sells pay worth minus fees)
 *   'a?b'         -> a - b when a exists, else -b (casino net: a win logs
 *                    won_amount AND bet_amount, a loss only the bet)
 * Returns null when the expression references a field the data lacks. For a
 * derived expression that null is authoritative (see moneyOf_); a plain field
 * name falls back to firstKey_ and then to Exceptions.
 */
function moneyExpr_(d, expr) {
  expr = String(expr || '').trim();
  if (!expr) return null;

  var m = expr.match(/^([A-Za-z_]+)\s*\/\s*2$/);
  if (m) return d[m[1]] === undefined ? null : Math.floor(num_(d[m[1]]) / 2);

  m = expr.match(/^([A-Za-z_]+)\s*-\s*([A-Za-z_]+)$/);
  if (m) {
    return (d[m[1]] !== undefined && d[m[2]] !== undefined)
      ? num_(d[m[1]]) - num_(d[m[2]]) : null;
  }

  // 'a?b' — casino-style net. A winning entry logs both fields (net in), a
  // losing entry only the bet (net out, returned negative so it can sit on
  // the income tab as a true signed movement).
  m = expr.match(/^([A-Za-z_]+)\?([A-Za-z_]+)$/);
  if (m) {
    if (d[m[1]] !== undefined) return num_(d[m[1]]) - num_(d[m[2]]);
    if (d[m[2]] !== undefined) return -num_(d[m[2]]);
    return null;
  }

  return d[expr] !== undefined ? num_(d[expr]) : null;
}
