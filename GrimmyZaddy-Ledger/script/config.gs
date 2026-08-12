/**
 * 00_Config — shared constants and the small helpers every other file leans on.
 *
 * Apps Script puts all .gs files in one global namespace, so nothing here needs
 * exporting and load order does not matter: these constants are only read from
 * inside functions, which run long after every file has loaded.
 */

var TABS = {
  RAW:     'RawLog',
  TYPES:   'LogTypeMap',
  INCOME:  'Income',
  EXPENSE: 'Expenses',
  EXCEPT:  'Exceptions',
  DASH:    'Dashboard'
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
 * property, church, jobs...). Extend if you also want e.g. vault (138) or
 * offshore bank (145) deposits tracked — those are transfers, not income/expense.
 */
var MONEY_CATS = [14, 17];

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

function fetchJson_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(res.getContentText());
  if (json.error) {
    throw new Error('Torn API error ' + json.error.code + ': ' + json.error.error);
  }
  return json;
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
