/**
 * 01_Setup — creates the tabs and pulls Torn's log-type reference (API v2).
 *
 * Run once via Torn > 1. Setup sheets, then again any time Torn adds log types.
 * refreshReference preserves your LogTypeMap direction edits, so re-running is
 * safe.
 */

function setupSheets() {
  tab_(TABS.RAW, ['ts', 'datetime_tct', 'log_type', 'category', 'title',
                  'money', 'item_id', 'item_name', 'qty', 'log_id', 'raw_data']);

  tab_(TABS.INCOME,  ['date', 'title', 'bucket', 'amount']);
  tab_(TABS.EXPENSE, ['date', 'title', 'bucket', 'amount']);
  tab_(TABS.EXCEPT,  ['date', 'log_type', 'title', 'problem', 'raw_data']);

  refreshReference();
  buildDashboard_();
  SpreadsheetApp.getUi().alert(
    'Setup done.\n\nNext: open LogTypeMap and set the `direction` column ' +
    '(income / expense / item_in / item_out / ignore), then run Torn > 2. Sync now.');
}

/**
 * Pull torn/logtypes into the LogTypeMap tab, preserving your direction edits.
 *
 * Deliberately does NOT fetch torn/items: that list is tens of thousands of rows,
 * and this ledger only needs the money amount and the log title, both of which
 * every entry carries on its own. Skipping that one huge fetch is the single
 * biggest speed win in setup.
 */
function refreshReference() {
  var k = key_();
  var types = fetchJson_(API + '/torn/logtypes?key=' + k).logtypes || [];
  var headers = ['id', 'title', 'direction', 'bucket', 'money_key'];
  var sheet = tab_(TABS.TYPES, headers);

  // Always rewrite the header row. tab_() only sets headers on first creation.
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  var existing = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
      if (r[0]) existing[String(r[0])] = r;
    });
  }

  var rows = types.map(function (t) {
    if (existing[String(t.id)]) return existing[String(t.id)];
    return [Number(t.id), t.title, guessDirection_(t.title),
            guessBucket_(t.title), ''];
  });
  rows.sort(function (a, b) { return a[0] - b[0]; });

  clearBody_(sheet);
  writeRows_(sheet, rows);
}

/**
 * Keyword guess at a log type's direction. Deliberately conservative — it leaves
 * most things as 'ignore' so you consciously opt each money-moving type in.
 * The LogTypeMap is the real control panel; these guesses are just a head start.
 */
function guessDirection_(title) {
  var t = String(title).toLowerCase();
  if (/abroad buy|item market buy|bazaar buy|item buy|shop buy/.test(t))     return 'item_in';
  if (/receive.*trade|trade.*receive|received.*items/.test(t))               return 'item_in';
  if (/item market sell|bazaar sell|item sell|sold|shop sell|pawn/.test(t))  return 'item_out';
  if (/rent|upkeep|staff|maintenance|bill|fee/.test(t))                      return 'expense';
  if (/money.*(sent|out)|casino.*lose|lost|bounty.*place/.test(t))           return 'expense';
  if (/money.*(in|receiv)|casino.*(win|won)|bounty.*(receiv|collect)|interest|dividend|income/.test(t)) return 'income';
  return 'ignore';
}

function guessBucket_(title) {
  var t = String(title).toLowerCase();
  if (/rent|upkeep|property|island|staff|pilot|maid|butler|guard/.test(t)) return 'Property';
  if (/travel|flight|abroad|airstrip/.test(t))                             return 'Travel';
  if (/pawn|shop/.test(t))                                                 return 'Shop';
  if (/market/.test(t))                                                    return 'ItemMarket';
  if (/bazaar/.test(t))                                                    return 'Bazaar';
  if (/trade/.test(t))                                                     return 'Trade';
  if (/crime/.test(t))                                                     return 'Crime';
  if (/casino|poker|slots|blackjack|roulette|lottery/.test(t))             return 'Casino';
  return 'Other';
}
