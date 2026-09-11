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
  COMPARE:  'Compare',
  FVAULT:   'FactionVault',
  FLIPS:    'FlipProfit',
  ITEMS:    'ItemNames',
  CASHFLOW: 'CashFlow',
  TODAY:    'Today'
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
// field can never win. Log types with no matchable field at all are covered by
// DERIVED_MONEY_KEYS (e.g. high-low cash-in pays pot/2; stock sells pay net
// of fees) — see config.gs.
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
 * Log types whose `data` carries no field MONEY_KEYS can match, so a plain
 * money_key cannot express their amount. money_key accepts tiny derived
 * expressions instead (see moneyExpr_ in parse.gs):
 *   'field'         -> data.field
 *   'field/2'       -> floor(data.field / 2)
 *   'field-other'   -> data.field - data.other
 *
 * Verified against live logs:
 *   8315 "Casino high-low cash in half" -> {"round":N,"pot":P}; the payout is
 *        half the pot (floored — pot 4651 pays 2325).
 *   8314 "Casino high-low cash in full" -> same shape; payout is the whole pot
 *        (inferred from the type name — no live row seen yet).
 *   5511 "Stock sell" -> worth is gross; the wallet receives worth minus the
 *        broker fee in data.fees.
 * Setup writes these into the money_key column of new LogTypeMap rows and
 * heals blank ones on refresh; an explicitly chosen key is never overwritten.
 */
var DERIVED_MONEY_KEYS = {
  '8315': 'pot/2',
  '8314': 'pot',
  '5511': 'worth-fees',
  // 6020 "Hunting session": one entry carries the session's cost AND income,
  // so only the net is a real movement (verified: 22 of 84 real sessions
  // profited — the net genuinely swings both ways).
  '6020': 'income-cost',
  // 5450 "Bank investment": worth is principal+interest, amount the
  // principal. The interest is guaranteed, so it is recognized ONCE, when the
  // investment is made; the withdraw (5451) returns principal + already-
  // counted interest and is a pure transfer (see TRANSFER_TYPES).
  '5450': 'worth-amount'
};

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
 * Additional log categories that move money but live OUTSIDE the four ids
 * above. Verified against the TornCashflow mapping work: crime income
 * (money_gained), muggings, hunting, missions, dividends, job/company
 * specials, faction payday, property rent/upkeep/sales, bounties, and every
 * casino game each log under their own category — none of them are reachable
 * through 14/17/138/145, so a ledger that only walks those ids silently
 * misses all of it.
 *
 * The names are resolved to category ids from /torn/logcategories at runtime
 * (cached for 7 days in Script Properties — see moneyCategoryIds_()). A name
 * that matches nothing is skipped harmlessly, so the list can safely include
 * categories an account never touches.
 */
var EXTRA_MONEY_CAT_NAMES = [
  'Crimes', 'Organized crimes', 'Missions', 'Racing', 'Travel', 'Bounties',
  'Bail', 'Revive', 'Attacks', 'Property', 'Property rental', 'Upkeep',
  'Estate agents', 'Company', 'Job', 'Stocks', 'City finds', 'Faction',
  // Casino games: each of these categories carries bet/win log types.
  'Casino', 'Slots', 'Roulette', 'High-low', 'Keno', 'Craps', 'Lottery',
  'Blackjack', 'Spin the wheel', 'Russian roulette', 'Poker', 'Bookie',
];

/**
 * The casino subset of EXTRA_MONEY_CAT_NAMES. Casino log types get one
 * generic rule (mirroring TornCashflow's casinoNet): direction income with
 * the net money_key 'won_amount?bet_amount' — a win logs won_amount AND
 * bet_amount (net in), a loss only bet_amount (net out as a negative income
 * row), so a losing streak never renders as wins and bets never inflate the
 * Expenses tab. Covers every game, including high-low's pot cash-in, without
 * per-game special cases.
 */
var CASINO_CAT_NAMES = [
  'Casino', 'Slots', 'Roulette', 'High-low', 'Keno', 'Craps', 'Lottery',
  'Blackjack', 'Spin the wheel', 'Russian roulette', 'Poker', 'Bookie',
];

/**
 * Category NAMES that move money (the four core ids above plus every extra
 * name) — RawLog's category column stores Torn's own name string, so this is
 * what rebuild's unmapped-money safeguard matches against.
 */
var MONEY_CAT_NAME_SET = (function () {
  var s = {};
  ['Money outgoing', 'Money incoming', 'Vault', 'Offshore bank']
    .concat(EXTRA_MONEY_CAT_NAMES)
    .forEach(function (n) { s[n] = true; });
  return s;
})();

/**
 * Log types that move money between your own accounts — bank invest/withdraw,
 * cashier's checks, vault, offshore bank, loans, faction vault — which must be
 * excluded from the Compare view's "realized" figure, otherwise
 * Δnetworth = realized + unrealized would never balance: depositing to the bank
 * looks like an expense and withdrawing like income, while networth is flat.
 *
 * Faction vault moves are included even though Torn's networth total does not
 * track the vault (so a deposit genuinely lowers the reported total): it is the
 * same wallet<->storage shuffle, the user treats the vault as held money, and
 * the Dashboard shows the vault balance separately.
 *
 * Verified against /torn/{14,17,138,145}/logtypes. Company (6284/6285) and
 * bookie deposits are deliberately left out: networth's treatment of those
 * balances is ambiguous, and including or excluding them only shifts the
 * realized/unrealized split — never the total.
 */
var TRANSFER_TYPES = {
  // 5450 is deliberately NOT here anymore: bank interest is recognized as
  // income at invest time (money_key 'worth-amount'), so the withdraw (5451)
  // returns principal + already-counted interest and must not book cash.
  '5451': true, '5460': true, '5461': true,   // bank withdraw, cashier's check pair
  '5850': true, '5851': true,                 // vault deposit/withdraw
  '6726': true, '6735': true, '6736': true,   // faction vault deposit + gives (see FACTION_VAULT_*)
  '6010': true, '6011': true,                 // offshore bank deposit/withdraw
  '6200': true, '6201': true                  // loan increase/decrease
};

/**
 * Trade log types whose ITEM legs the sync fetches with a standalone log=
 * selection (the log param cannot be combined with cat, so they walk as their
 * own selection). Only the FINALIZED legs are fetched — they fire exclusively
 * when a trade actually completes, so cancelled/declined/expired trades never
 * produce a row:
 *   4445 "Trade items outgoing" — items you SENT in a completed trade
 *   4446 "Trade items incoming" — items you RECEIVED in a completed trade
 * They carry no money (just an items array), so the FlipProfit view values
 * them at the item catalog's market price.
 *
 * The trade MONEY legs (4440/4441) need no special handling: Torn lists them
 * in categories 14/17, which MONEY_CATS already fetches, and moneyOf_ already
 * reads their `money` field — so trade cash is in the ledger today.
 */
/**
 * Verified per-log-type mapping for money-bearing types the category rules
 * cannot place — field semantics confirmed against live log dumps (the same
 * mapping knowledge the TornCashflow userscript is built on). Format:
 *   id: { d: direction, b: bucket, k: optional money_key }
 *
 * Applied by refreshReference on new rows, and healed onto existing rows ONLY
 * while the row still holds the exact auto-guess this code would produce — a
 * deliberate user edit never matches the fresh guess, so it always survives.
 *
 * Deliberate accounting choices mirrored from TornCashflow:
 *   - 4800 'Money sent' is a transfer (a gift out is not a loss), while
 *     4810 'Money received' IS income — same asymmetry TornCashflow uses.
 *   - Crime loot / item finds / items sent-received (9020, 7011, 4102, 4103)
 *     are custody changes with no cash field: ignored here (the cash-only
 *     ledger has no item valuation; the FlipProfit view covers trade items).
 *   - 5510/5511 stock buy/sell are NOT transfers here, unlike TornCashflow:
 *     this ledger's Compare math needs the principal as cash flow so that
 *     delta = realized + unrealized stays balanced.
 */
var REFERENCE_LOGMAP = {
  // ---- income ----
  '9015': { d: 'income', b: 'Crime' },       // crime success (money_gained)
  '9052': { d: 'income', b: 'Crime' },       // bootlegging DVD sale
  '9056': { d: 'income', b: 'Crime' },       // skimming card-details sale
  '5720': { d: 'income', b: 'Crime' },       // crime 1.0 success money gain
  '8155': { d: 'income', b: 'Attacks' },     // you mug someone (money_mugged)
  '6220': { d: 'income', b: 'Job' },         // city job pay
  '6221': { d: 'income', b: 'Job' },         // company employee pay
  '6509': { d: 'income', b: 'Job' },         // company special payout
  '6404': { d: 'income', b: 'Job' },         // city job special payout
  '5531': { d: 'income', b: 'Stocks' },      // stock dividend (money)
  '5937': { d: 'income', b: 'Property' },    // property rent
  '5928': { d: 'income', b: 'Property' },    // property sold (cost = proceeds)
  '6012': { d: 'income', b: 'Bank' },        // offshore bank interest
  '7815': { d: 'income', b: 'Mission' },     // mission reward (credits not counted)
  '4810': { d: 'income', b: 'Other' },       // money received from a player
  '6811': { d: 'income', b: 'Faction' },     // faction payday received
  '1113': { d: 'income', b: 'ItemMarket' },  // item market sell (net proceeds)
  '1104': { d: 'income', b: 'ItemMarket' },  // legacy market sell
  '1226': { d: 'income', b: 'Bazaar' },      // bazaar sell
  '1221': { d: 'income', b: 'Bazaar' },      // legacy bazaar sell
  '5011': { d: 'income', b: 'Points' },      // points sold to a player
  // ---- expense ----
  '9030': { d: 'expense', b: 'Crime' },      // lost hustling wager (money_lost)
  '5715': { d: 'expense', b: 'Crime' },      // crime 1.0 fail money loss
  '9165': { d: 'expense', b: 'Crime' },      // crime critical fail
  '9053': { d: 'expense', b: 'Crime' },      // bootlegging online store cost
  '9071': { d: 'expense', b: 'Crime' },      // crime cost
  '8156': { d: 'expense', b: 'Attacks' },    // you got mugged (money_mugged)
  '4200': { d: 'expense', b: 'Shop' },       // shop purchase
  '4201': { d: 'expense', b: 'Abroad' },     // goods bought abroad
  '6001': { d: 'expense', b: 'Travel' },     // flight fee
  '6015': { d: 'expense', b: 'Travel' },     // fortune teller
  '5920': { d: 'expense', b: 'Property' },   // property upkeep
  '5927': { d: 'expense', b: 'Property' },   // property bought
  '5900': { d: 'expense', b: 'Property' },   // property upgrade
  '5960': { d: 'expense', b: 'Other' },      // education cost
  '6005': { d: 'expense', b: 'Other' },      // rehab cost
  '5555': { d: 'expense', b: 'Other' },      // subscription
  '8705': { d: 'expense', b: 'Racing' },     // racing upgrade
  '6700': { d: 'expense', b: 'Bounties' },   // bounty placed (cost = reward + fee)
  '5010': { d: 'expense', b: 'Points' },     // points bought on the market
  // ---- transfers (own money moving, never profit) ----
  '4800': { d: 'transfer_out', b: 'Other' },   // money sent to a player
  '5451': { d: 'transfer_in',  b: 'Bank' },    // bank withdraw (interest already counted)
  '5461': { d: 'transfer_in',  b: 'Bank' },    // cashier's check received half
  '5460': { d: 'transfer_out', b: 'Bank' },    // cashier's check sent half
  '6810': { d: 'transfer_out', b: 'Faction' }, // faction payday paid to a member
  // ---- deliberately not money for this ledger ----
  '6795': { d: 'ignore', b: 'Faction' },     // OC payout into the vault (vault math)
  '8166': { d: 'ignore', b: 'Attacks' },     // you got arrested (someone else's bounty)
  '5371': { d: 'ignore', b: 'Other' },       // someone else bailed you out
  '5521': { d: 'ignore', b: 'Stocks' },      // stock merge (amount = share count)
  '9020': { d: 'ignore', b: 'Crime' },       // crime loot items (no cash field)
  '7011': { d: 'ignore', b: 'Other' },       // item find (no cash field)
  '4102': { d: 'ignore', b: 'Trade' },       // items sent (custody change)
  '4103': { d: 'ignore', b: 'Trade' },       // items received (custody change)
  '4442': { d: 'ignore', b: 'Trade' },       // trade-window money add (intermediate)
  '4443': { d: 'ignore', b: 'Trade' },       // trade-window money remove (intermediate)
  '4480': { d: 'ignore', b: 'Trade' },       // THEIR trade-window money add
  '4481': { d: 'ignore', b: 'Trade' }        // THEIR trade-window money remove
};

var TRADE_TYPES = [4445, 4446];

/**
 * Faction vault money movements, verified against /torn/80/logtypes and live
 * log samples. The vault balance is maintained from these (see
 * derivedFactionVault_): deposits (6726, money_deposited) add, gives
 * (6735/6736, money_given) subtract, and a balance-change log is
 * authoritative — its balance_after IS the balance, no math:
 *   6737/6738 "Faction money balance change (send|receive)" — fires when any
 *     banker adjusts the vault balances. The `user` field is the BANKER who
 *     made the change (it can be anyone with vault access), NOT the balance
 *     owner — a log in your own feed is always about YOUR balance, so
 *     balance_after applies unconditionally.
 *   6795 "Faction payout money balance receive" — organized-crime payout,
 *     carries balance_before/balance_after too (verified: its 8/14 before
 *     exactly matched the user's reported vault balance). Also authoritative.
 *
 * 6735/6737/6738/6795 live in category 80 (Faction), outside the money
 * categories the sync walks, so they are fetched with a standalone log=
 * selection (FACTION_VAULT_SYNC). 6726 is in category 14 and 6736 in
 * category 17, so they are already synced. The balance fields are NOT in
 * MONEY_KEYS: rebuild must never treat a vault rebalance as income/expense.
 */
var FACTION_VAULT_IN      = { '6726': true };
var FACTION_VAULT_OUT     = { '6735': true, '6736': true };
var FACTION_VAULT_BALANCE = { '6737': true, '6738': true, '6795': true };
var FACTION_VAULT_SYNC    = [6735, 6737, 6738, 6795];

/**
 * File-size control. RawLog is append-only and every row carries the log's full
 * JSON payload (raw_data), so the file grows with history. COMPACTION keeps the
 * math exact while the sheet stays small: once a row is older than
 * RETENTION_DAYS its money is resolved with the CURRENT LogTypeMap (per-type
 * money_key overrides included) and frozen into the money column, then raw_data
 * and the dead datetime/category columns are blanked. Trade legs (4440/4441/
 * 4445/4446) keep their raw JSON — parsed_trade_id is load-bearing for the flip
 * view — as do rows whose money cannot be resolved (exception candidates).
 * Compaction runs automatically once RawLog exceeds COMPACT_AT_ROWS, and on
 * demand via the menu. Idempotent: re-running it changes nothing.
 */
var RETENTION_DAYS = 90;
var COMPACT_AT_ROWS = 20000;
var TRADE_RAW_KEEP = { '4440': true, '4441': true, '4445': true, '4446': true };

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

/**
 * Every category id the sync should walk: MONEY_CATS plus the
 * EXTRA_MONEY_CAT_NAMES resolved to ids from /torn/logcategories. Resolution
 * is cached in Script Properties for 7 days (EXTRA_CAT_IDS / EXTRA_CAT_IDS_TS)
 * so the hourly sync costs no extra request; a failed refresh falls back to
 * the last cache, then to MONEY_CATS alone.
 */
function moneyCategoryIds_() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('EXTRA_CAT_IDS');
  var ts = Number(props.getProperty('EXTRA_CAT_IDS_TS') || 0);
  if (cached && Date.now() - ts < 7 * 86400000) {
    try { return MONEY_CATS.concat(JSON.parse(cached)); } catch (e) { /* refetch */ }
  }
  var extras = [];
  try {
    var j = fetchJson_(API + '/torn/logcategories?key=' + key_());
    var cats = j.logcategories || j.categories || [];
    var want = {};
    EXTRA_MONEY_CAT_NAMES.forEach(function (n) { want[String(n).toLowerCase()] = true; });
    cats.forEach(function (c) {
      if (want[String(c.title || c.name || '').toLowerCase()]) extras.push(num_(c.id));
    });
    props.setProperty('EXTRA_CAT_IDS', JSON.stringify(extras));
    props.setProperty('EXTRA_CAT_IDS_TS', String(Date.now()));
  } catch (e) {
    if (cached) { try { return MONEY_CATS.concat(JSON.parse(cached)); } catch (e2) {} }
  }
  return MONEY_CATS.concat(extras);
}

/** BACKFILLED_CATS property -> {catIdString: true} (sync.gs backfill tracking). */
function readBackfilledCats_(props) {
  var set = {};
  try {
    JSON.parse(props.getProperty('BACKFILLED_CATS') || '[]')
      .forEach(function (c) { set[String(c)] = true; });
  } catch (e) { /* treat as empty */ }
  return set;
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
