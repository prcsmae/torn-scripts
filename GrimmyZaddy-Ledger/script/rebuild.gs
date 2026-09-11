/**
 * 04_Rebuild — turns RawLog into the Income and Expenses ledgers.
 *
 * rebuild() is total and idempotent: it clears every derived tab and rewrites it
 * from scratch, so running it twice changes nothing. Never append incrementally to
 * a derived tab — it duplicates on every rerun, and the duplication looks like real
 * data.
 */

/**
 * Full recompute of Income and Expenses from RawLog. Idempotent by design — if the
 * numbers ever look wrong, fix LogTypeMap and re-run this. Nothing is lost because
 * RawLog is never touched.
 */
function rebuild() {
  var raw   = readRaw_();
  var types = readTypeMap_();

  var income = [], expenses = [], exceptions = [];

  function flag_(r, problem) {
    exceptions.push([new Date(r.ts * 1000), r.logType, r.title, problem,
                     String(r.raw).substring(0, 300)]);
  }

  raw.sort(function (a, b) { return a.ts - b.ts; });

  raw.forEach(function (r) {
    var t = types[r.logType];
    if (!t || t.direction === 'ignore') {
      // Safety net (mirrors TornCashflow's uncategorized panel): a log in a
      // money category that nothing accounts for, whose data carries a cash
      // field, is surfaced instead of silently dropped — Torn adds log types
      // over time and this is the only way they announce themselves. Types
      // the reference deliberately ignores (8166 arrest carries SOMEONE
      // ELSE's bounty money, 5521's amount is a share count, item custody
      // changes) are exempt.
      var ref = REFERENCE_LOGMAP[r.logType];
      if (ref && ref.d === 'ignore') return;
      if (MONEY_CAT_NAME_SET[r.category]) {
        var probe = firstKey_(parseRaw_(r), MONEY_KEYS);
        if (probe !== null && num_(probe) !== 0) {
          flag_(r, 'Unmapped money log in category "' + r.category +
            '" — it carries a cash field but nothing accounts for it. Set ' +
            'direction/money_key on LogTypeMap, or add it to REFERENCE_LOGMAP.');
        }
      }
      return;
    }
    if (!INCOME_DIRS[t.direction] && !EXPENSE_DIRS[t.direction]) return;

    var amount = moneyOf_(r, t);
    if (amount === null) {
      flag_(r, INCOME_DIRS[t.direction]
        ? 'Money-in log but no money field found — set money_key on LogTypeMap.'
        : 'Expense log but no money field found — set money_key on LogTypeMap, or ' +
          'set direction to ignore if this log is only a notification.');
      return;
    }

    var date = new Date(r.ts * 1000);
    if (INCOME_DIRS[t.direction]) {
      income.push([date, r.title, t.bucket, amount]);
    } else {
      expenses.push([date, r.title, t.bucket, amount]);
    }
  });

  var iSheet = tab_(TABS.INCOME);  clearBody_(iSheet);  writeRows_(iSheet, income);
  var eSheet = tab_(TABS.EXPENSE); clearBody_(eSheet);  writeRows_(eSheet, expenses);

  var xSheet = tab_(TABS.EXCEPT, ['date', 'log_type', 'title', 'problem', 'raw_data']);
  clearBody_(xSheet); writeRows_(xSheet, exceptions);
  return exceptions.length;
}

// ---------- readers

function readRaw_() {
  var sheet = tab_(TABS.RAW);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return {
        ts: num_(r[0]), logType: String(r[2]), category: r[3], title: r[4],
        money: num_(r[5]), itemId: r[6] ? String(r[6]) : '',
        itemName: r[7] || '', qty: num_(r[8]) || 1, raw: r[10]
      };
    });
}

function readTypeMap_() {
  var sheet = tab_(TABS.TYPES);
  var map = {};
  if (sheet.getLastRow() < 2) return map;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().forEach(function (r) {
    if (!r[0]) return;
    map[String(r[0])] = {
      title: r[1],
      direction: String(r[2] || 'ignore').trim().toLowerCase(),
      bucket: r[3] || 'Other',
      moneyKey: String(r[4] || '').trim()
    };
  });
  return map;
}
