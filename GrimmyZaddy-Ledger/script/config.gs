/**
 * 00_Config — shared constants and the small helpers every other file leans on.
 *
 * Apps Script puts all .gs files in one global namespace, so nothing here needs
 * exporting and load order does not matter: these constants are only read from
 * inside functions, which run long after every file has loaded.
 */

var TABS = {
  RAW:      'RawLog',
  TYPES:    'LogTypeMap',
  INCOME:   'Income',
  EXPENSE:  'Expenses',
  EXCEPT:   'Exceptions',
  DASH:     'Dashboard',
  NETWORTH: 'Networth',
  COMPARE:  'Compare'
};

// Torn API v2. The log selection requires a full-access key.
var API = 'https://api.torn.com/v2';

// Candidate keys used when digging a money amount out of a log's `data` object.
// Money field names vary wildly by log type, verified against live data:
//   bazaar/market/abroad trades -> cost_total, item shop sell -> total_value,
//   casino wins -> won_amount (wins carry BOTH bet_amount and won_amount, so
//   won_amount must come first), losses -> bet_amount, property upkeep ->
//   upkeep_paid, rentals -> rent, crimes -> money_gained, faction ->
//   money_deposited/money_given, company pay -> pay, loans -> returned.
// Type-specific keys must precede the generic `value`/`amount` so a quantity
// field can never win.
var MONEY_KEYS = ['cost_total', 'total_cost', 'total_value', 'total', 'cost',
                  'money', 'money_mugged', 'money_gained', 'money_given',
                  'money_deposited', 'money_withdrawn', 'money_received',
                  'money_sent', 'money_lost', 'money_won', 'pay', 'returned',
                  'value', 'worth', 'price', 'won_amount', 'bet_amount',
                  'upkeep_paid', 'upkeep_due', 'rent', 'bounty_reward',
                  'interest', 'amount'];
var ITEM_KEYS  = ['item', 'item_id'];
var QTY_KEYS   = ['quantity', 'qty', 'amount'];

/**
 * Torn's own log categories that move money, used to filter /user/log so only
 * income/expense entries are ever downloaded. Verified against /torn/logcategories
 * and /torn/{id}/logtypes: category 14 "Money outgoing" and category 17
 * "Money incoming" between them cover every money-moving log type (bazaar and
 * item-market buys/sells, trade money legs, casino, crime, bank, stocks, bounties,
 * property, church, jobs...). 138 (Vault) and 145 (Offshore bank) are transfers —
 * money moved between your wallet and storage — also tracked so every movement
 * of cash lands in the ledger. The cat param accepts one id, so the sync walks
 * each category separately.
 */
var MONEY_CATS = [14, 17, 138, 145];

/**
 * Log types that move money BETWEEN networth buckets without changing the total
 * (bank invest/withdraw, cashier's checks, vault, offshore bank, loans). They
 * must be excluded from the Compare view's "realized" figure, otherwise
 * Δnetworth = realized + unrealized would never balance: depositing to the bank
 * looks like an expense and withdrawing like income, while networth is flat.
 *
 * Verified against /torn/{14,17,138,145}/logtypes. Company (6284/6285) and
 * bookie deposits are deliberately left out: networth's treatment of those
 * balances is ambiguous, and including or excluding them only shifts the
 * realized/unrealized split — never the total.
 */
var TRANSFER_TYPES = {
  '5450': true, '5451': true, '5460': true,   // bank invest/withdraw, cashier's check
  '5850': true, '5851': true,                 // vault deposit/withdraw
  '6010': true, '6011': true,                 // offshore bank deposit/withdraw
  '6200': true, '6201': true                  // loan increase/decrease
};

/** Background tints for conditional formatting: gain / loss / flat. */
var CF_COLORS = { pos: '#d9ead3', neg: '#f4cccc', neutral: '#eeeeee' };

/**
 * Which LogTypeMap directions count as money moving. Anything else — item_loss,
 * trades by item, travel, notifications — is ignored, because this ledger only
 * asks "did money come in, and did money go out".
 */
var INCOME_DIRS  = { income: true, item_out: true };
var EXPENSE_DIRS = { expense: true, item_in: true };

/**
 * API key: Script Properties first (TORN_API_KEY), then the gitignored
 * private.gs fallback (TORN_API_KEY_DEFAULT).
 */
function key_() {
  var k = PropertiesService.getScriptProperties().getProperty('TORN_API_KEY');
  if (!k && typeof TORN_API_KEY_DEFAULT === 'string') k = TORN_API_KEY_DEFAULT;
  if (!k) {
    throw new Error('No API key. Set TORN_API_KEY in Script Properties, or fill ' +
                   'TORN_API_KEY_DEFAULT in private.gs.');
  }
  return k;
}

// Pace every API call to at most one per second (60/min, comfortably under
// Torn's 100/min limit). A backfill run makes hundreds of calls; without this
// the category boundaries burst and Torn answers with error 5.
var _lastFetchMs = 0;

function fetchJson_(url) {
  var gap = 1000 - (Date.now() - _lastFetchMs);
  if (gap > 0) Utilities.sleep(gap);
  _lastFetchMs = Date.now();

  // Rate limit (error 5) is transient: wait out the window and retry instead of
  // aborting the run. Any other error still throws immediately.
  var tries = 0;
  while (true) {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var json = JSON.parse(res.getContentText());
    if (json.error) {
      if (json.error.code === 5 && tries < 3) {
        tries++;
        Utilities.sleep(60000);
        _lastFetchMs = Date.now();   // resume pacing from the retry, not the stale failed call
        continue;
      }
      throw new Error('Torn API error ' + json.error.code + ': ' + json.error.error);
    }
    return json;
  }
}

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function tab_(name, headers) {
  var sheet = ss_().getSheetByName(name);
  if (!sheet) {
    sheet = ss_().insertSheet(name);
    if (headers) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/** Wipe everything below the header row. */
function clearBody_(sheet) {
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  }
}

/** Bulk-write rows starting at row 2. No-op on empty input. */
function writeRows_(sheet, rows) {
  if (!rows.length) return;
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function num_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function firstKey_(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
  }
  return null;
}

/**
 * Green/red/neutral conditional-format rules for money cells, applied per cell
 * so empty cells stay unstyled. Accepts one range or an array of ranges (used
 * to cover several disjoint rows on the Dashboard). Re-applied on every rebuild
 * because clear() wipes conditional formatting.
 */
function cfMoneyRules_(ranges) {
  var arr = Array.isArray(ranges) ? ranges : [ranges];
  return [
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground(CF_COLORS.pos).setRanges(arr).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0).setBackground(CF_COLORS.neg).setRanges(arr).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberEqualTo(0).setBackground(CF_COLORS.neutral).setRanges(arr).build()
  ];
}
