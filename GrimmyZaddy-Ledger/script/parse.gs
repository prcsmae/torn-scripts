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

  // A row with no raw JSON was compacted: its money was resolved with the
  // LogTypeMap of the day and frozen into the money column, so a non-zero number
  // there IS the amount — the key cannot be re-evaluated against data that no
  // longer exists here. This check comes first because every derived key (a
  // stake's '-bet', craps' 'sum:winnings', high-low's 'pot') would otherwise
  // report "no money field" for a compacted row and flag it forever with nothing
  // to fix. A raw-less row with nothing frozen either is uninterpretable — see
  // classifyRaw_ in rebuild.gs, which reports it instead of booking a $0
  // movement — so it comes back as null.
  if (!r.raw) return num_(r.money) || null;

  if (t && t.moneyKey) {
    var v = moneyExpr_(d, t.moneyKey);
    if (v !== null) return v;
    // A DERIVED expression (/2, a-b, a?b, -a, sum:a) encodes the exact shape of
    // one log type, so a missing field means the row does not match the type's
    // known shape and must NOT be re-guessed by firstKey_ — a casino loss would
    // otherwise fall back to bet_amount and be booked as a WIN. Plain field
    // names keep the fallback for compatibility with older maps.
    if (/[\/?-]/.test(t.moneyKey)) return null;
  }

  var v2 = firstKey_(d, MONEY_KEYS);
  if (v2 !== null) return num_(v2);

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
 * field name, a few tiny derived forms cover log types whose data carries no
 * directly matchable money field (the amount must be computed — see
 * DERIVED_MONEY_KEYS and CASINO_LOGMAP in config.gs for which types need this
 * and why). Any of them may carry a leading '-' to book the amount as money
 * OUT, which is how a stake is expressed without inventing a second direction:
 *   'field'        -> data.field
 *   '-field'       -> -data.field               (a stake: blackjack -bet)
 *   'field/2'      -> floor(data.field / 2)     (high-low cash-in half)
 *   'field-other'  -> data.field - data.other   (stock sell: worth - fees)
 *   'a?b'          -> a - b when a exists, else -b (v1 casino net)
 *   'sum:field'    -> the amounts in data.field, an array of {label: amount}
 *                     entries (v2 craps logs stakes and returns that way);
 *                     '-sum:field' subtracts the total
 * Returns null when the expression references a field the data lacks. For a
 * derived expression that null is authoritative (see moneyOf_); a plain field
 * name falls back to firstKey_ and then to Exceptions.
 */
function moneyExpr_(d, expr) {
  expr = String(expr || '').trim();
  if (!expr) return null;

  var neg = expr.charAt(0) === '-';
  var v = moneyExprPos_(d, neg ? expr.substring(1).trim() : expr);
  if (v === null) return null;
  return neg ? -v : v;
}

/** One money_key form, sign already stripped by moneyExpr_. */
function moneyExprPos_(d, expr) {
  if (!expr) return null;

  // Array-of-labelled-amounts form: [{"buy_4":1000},{"hard_8":1000}]. A
  // malformed entry contributes nothing, and an empty array is not a zero
  // amount — it is a log whose shape we do not recognise, so it flags.
  var m = expr.match(/^sum:([A-Za-z_]+)$/);
  if (m) {
    var arr = d[m[1]];
    if (!Array.isArray(arr) || !arr.length) return null;
    var total = 0;
    arr.forEach(function (e) {
      Object.keys(e || {}).forEach(function (k) { total += num_(e[k]); });
    });
    return total;
  }

  m = expr.match(/^([A-Za-z_]+)\s*\/\s*2$/);
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

/**
 * The type rows rebuild and the Compare math actually classify with.
 *
 * LogTypeMap stays the control panel, but a row nobody configured is filled in
 * from the verified tables rather than flagged forever. That matters because
 * the heal that updates the sheet (refreshReference) can only recognise a row
 * that still matches the current auto-guess — and the guessing rules changed
 * over time, so rows written by an older version (Job pay sat at bucket 'Other'
 * before the Job rule existed) could never be healed again and every rebuild
 * re-flagged them. Resolution happens here instead, where it costs no API call
 * and no sheet edit:
 *   - the row is missing from LogTypeMap entirely (some money types are not in
 *     /torn/logtypes at all), or
 *   - its money_key is the generic casino net 'won_amount?bet_amount' (the v1
 *     shape, written as a guess and never by hand), or
 *   - it is the default 'ignore' with no money_key.
 *
 * Anything else is a considered choice and passes through untouched — including
 * a deliberate 'ignore', which only needs a money_key next to it (an ignored
 * row's key is never read, so any text works) to stay out of the ledger.
 */
function effectiveTypes_(sheetTypes) {
  var out = {};
  Object.keys(sheetTypes || {}).forEach(function (id) { out[id] = sheetTypes[id]; });

  function unconfigured_(row) {
    if (!row) return true;
    var k = String(row.moneyKey || '').trim();
    if (k) return !!STALE_GUESS_KEYS[k];
    return String(row.direction || '') === 'ignore';
  }

  function fill_(id, direction, tableBucket, moneyKey) {
    // Keep a bucket you relabelled yourself — only the catch-all default and a
    // blank can be an auto-guess. Same rule as healLegacyGuesses_, so the sheet
    // and rebuild never disagree about where a row belongs.
    var row = out[id];
    var bucket = (row && row.bucket && row.bucket !== 'Other') ? row.bucket : tableBucket;
    out[id] = { title: (row && row.title) || '', direction: direction,
                bucket: bucket, moneyKey: moneyKey };
  }

  Object.keys(REFERENCE_LOGMAP).forEach(function (id) {
    if (!unconfigured_(out[id])) return;
    var ref = REFERENCE_LOGMAP[id];
    fill_(id, ref.d, ref.b || 'Other', ref.k || '');
  });
  Object.keys(CASINO_LOGMAP).forEach(function (id) {
    if (!unconfigured_(out[id])) return;
    var game = CASINO_LOGMAP[id];
    fill_(id, game.d, 'Casino', game.k || '');
  });
  return out;
}
