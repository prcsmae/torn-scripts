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
    'Setup done.\n\nLogTypeMap directions for every money-moving log type are ' +
    'already filled in from Torn\'s own money categories. Review and adjust, ' +
    'then run Torn > 2. Sync now.');
}

/**
 * Pull torn/logtypes into the LogTypeMap tab, preserving your direction edits.
 *
 * Directions come from Torn's own categorization: log types in category 14
 * ("Money outgoing") default to expense, category 17 ("Money incoming") to income,
 * everything else to ignore. No title guessing for money types — Torn already
 * classified them, and its word for it is more reliable than ours.
 *
 * Deliberately does NOT fetch torn/items: that list is tens of thousands of rows,
 * and this ledger only needs the money amount and the log title, both of which
 * every entry carries on its own. Skipping that one huge fetch is the single
 * biggest speed win in setup.
 */
function refreshReference() {
  var k = key_();
  var types = fetchJson_(API + '/torn/logtypes?key=' + k).logtypes || [];
  var headers = ['id', 'title', 'direction', 'bucket', 'money_key', 'category'];
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

  // Which log types belong to which money category.
  var outIds = categoryTypeIds_(k, 14);
  var inIds  = categoryTypeIds_(k, 17);

  var rows = types.map(function (t) {
    if (existing[String(t.id)]) return existing[String(t.id)];
    var id = String(t.id);
    var category = outIds[id] ? 'Money outgoing' : (inIds[id] ? 'Money incoming' : '-');
    var direction = outIds[id] ? 'expense'
                  : inIds[id] ? 'income'
                  : guessDirection_(t.title);
    return [Number(t.id), t.title, direction, guessBucket_(t.title), '', category];
  });
  rows.sort(function (a, b) { return a[0] - b[0]; });

  clearBody_(sheet);
  writeRows_(sheet, rows);
}

/**
 * id -> true lookup of the log types in one category. A transient failure here
 * returns an empty set rather than aborting the whole refresh: those types then
 * fall back to title guessing, and re-running Setup later repairs them.
 */
function categoryTypeIds_(k, catId) {
  var set = {};
  try {
    var types = fetchJson_(API + '/torn/' + catId + '/logtypes?key=' + k).logtypes || [];
    types.forEach(function (t) { set[String(t.id)] = true; });
  } catch (e) { /* degrade to title guessing */ }
  return set;
}

/**
 * Title-based fallback for log types outside the money categories. Deliberately
 * conservative — it leaves most things as 'ignore' so you consciously opt in.
 * (Money types never reach this: their direction comes from their category.)
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
  if (/rent|upkeep|property|island|pilot|maid|butler|guard/.test(t)) return 'Property';
  if (/bounty/.test(t))                                              return 'Bounties';
  if (/stock/.test(t))                                               return 'Stocks';
  if (/bank|invest|loan|interest/.test(t))                           return 'Bank';
  if (/church|donate/.test(t))                                       return 'Church';
  if (/faction/.test(t))                                             return 'Faction';
  if (/job|company|employee|payday/.test(t))                         return 'Job';
  if (/racing/.test(t))                                              return 'Racing';
  if (/mission/.test(t))                                             return 'Mission';
  if (/advert|classified/.test(t))                                   return 'Adverts';
  if (/auction/.test(t))                                             return 'Auction';
  if (/mug|attack|arrest/.test(t))                                   return 'Attacks';
  if (/travel|flight|abroad|airstrip/.test(t))                       return 'Travel';
  if (/pawn|shop/.test(t))                                           return 'Shop';
  if (/market/.test(t))                                              return 'ItemMarket';
  if (/bazaar/.test(t))                                              return 'Bazaar';
  if (/trade/.test(t))                                               return 'Trade';
  if (/crime/.test(t))                                               return 'Crime';
  if (/casino|poker|slots|blackjack|roulette|lottery/.test(t))       return 'Casino';
  return 'Other';
}
