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
  TODAY:    'Today',
  AUDIT:    'MappingAudit'
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
 *   5511 "Stock sell" -> worth is gross; the wallet receives worth minus the
 *        broker fee in data.fees.
 * Casino log types are deliberately NOT here — their per-game v2 shapes live in
 * CASINO_LOGMAP below, next to the generic guess they replace.
 * Setup writes these into the money_key column of new LogTypeMap rows and
 * heals blank ones on refresh; an explicitly chosen key is never overwritten.
 */
var DERIVED_MONEY_KEYS = {
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
 * The casino subset of EXTRA_MONEY_CAT_NAMES. Casino log types share one
 * accounting convention: direction income as SIGNED rows, so a losing session
 * never renders as wins and stakes never inflate the Expenses rankings — a
 * stake is a negative income row, a return is positive, and Torn's three-hour
 * high-low table reads as one net line. The per-game `data` field names differ
 * (v2 renamed them per game), so the amounts come from CASINO_LOGMAP below;
 * this list is only what identifies a log as casino in the first place.
 */
var CASINO_CAT_NAMES = [
  'Casino', 'Slots', 'Roulette', 'High-low', 'Keno', 'Craps', 'Lottery',
  'Blackjack', 'Spin the wheel', 'Russian roulette', 'Poker', 'Bookie',
];

/**
 * The generic casino net key. It expresses the v1 log API's shape — a win logs
 * won_amount AND bet_amount, a loss only the bet — and is what the category
 * rule writes as a GUESS, never as a considered choice. Two things read it as
 * such: healLegacyGuesses_ replaces it with the verified per-game key below,
 * and effectiveTypes_ treats a row still holding it as unconfigured.
 */
var CASINO_GUESS_KEY = 'won_amount?bet_amount';

/**
 * money_key values that are auto-guesses rather than choices: a row still
 * holding one was never configured by hand, so effectiveTypes_ (parse.gs) may
 * override it and healLegacyGuesses_ (setup.gs) may rewrite it.
 */
var STALE_GUESS_KEYS = {};
STALE_GUESS_KEYS[CASINO_GUESS_KEY] = true;

/**
 * Verified v2 `data` shapes for casino log types, replacing the generic key
 * above. The v2 log API renamed the fields per game, so the generic key matches
 * nothing and every game except high-low's start landed in Exceptions; the
 * category rule exists to keep casino money on one ledger line, not to spell
 * out its fields.
 *
 * The accounting convention is unchanged (see CASINO_CAT_NAMES): money out when
 * the stake leaves, money in for every gross amount that comes back, direction
 * always `income` so a losing session shows as a negative income row instead of
 * inflating the Expenses rankings. Nothing here is guessed — each entry is
 * verified against live v2 dumps, and the arithmetic it produces is the check:
 *   blackjack  bet 5000 -> winnings 10000                    = +5000 (even money)
 *              bet 10000 -> winnings 25000, "with a natural" = +15000 (3:2)
 *              => winnings is the GROSS return, so the stake is booked ONCE, at
 *                 start; booking the lose log's `losses` too would double it.
 *   craps      field 10000 -> winnings 20000                 = 2x (gross, again)
 *              buy_9 10000 -> winnings 24500                 = 3:2 (15000) + stake
 *                                                              less the 5% buy fee
 *              come-out 7   -> winnings list the RETURNED stakes, losses the
 *                              one that died, so bets = out and winnings = in.
 *   high-low   bet_amount out at start; the rounds only grow the pot and the
 *              payout lands on the cash-in (full = pot, half = floor(pot/2)),
 *              so a busted game costs exactly the ante.
 *   d: direction, k: the money_key ('' = the log moves no money)
 *
 * Types NOT in this table keep the generic guess and fail loudly into
 * Exceptions — that is the point of the table, not an oversight. Still unknown
 * (their RawLog rows carry no raw JSON): slots 8301 and roulette 8306 losses,
 * and whether blackjack's push (8358) logs the returned stake. Get a shape with
 * Torn > 5. Inspect a log type and the entry can be written.
 */
var CASINO_LOGMAP = {
  '8310': { d: 'income', k: '-bet_amount' },   // high-low: the ante
  '8311': { d: 'ignore', k: '' },              // round lost (pot bookkeeping)
  '8312': { d: 'ignore', k: '' },              // round drawn
  '8313': { d: 'ignore', k: '' },              // round won — pot grew, nothing paid
  '8314': { d: 'income', k: 'pot' },           // cash in full
  '8315': { d: 'income', k: 'pot/2' },         // cash in half (floored)
  '8330': { d: 'income', k: '-sum:bets' },     // craps: the stakes
  '8331': { d: 'income', k: 'sum:winnings' },  // craps: what came back
  '8332': { d: 'ignore', k: '' },              // craps loss — already staked
  '8340': { d: 'income', k: '-cost' },         // lottery ticket
  '8350': { d: 'income', k: '-bet' },          // blackjack: the stake
  '8351': { d: 'ignore', k: '' },              // blackjack hit
  '8354': { d: 'ignore', k: '' },              // blackjack loss — stake already booked
  '8355': { d: 'income', k: 'winnings' },      // blackjack win (gross return)
  '8370': { d: 'income', k: '-cost' },         // spin the wheel ticket
  '8374': { d: 'income', k: 'money' },         // spin the wheel win money
  '8400': { d: 'income', k: 'refund' }         // russian roulette: leaving refunds the buy-in
};

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
 * Applied on three paths, so the mapping cannot be lost between them:
 *   - refreshReference writes it onto rows it builds, and heals rows that still
 *     hold the old auto-guess (a direction you picked survives, and so does a
 *     bucket you relabelled — the heal no longer requires the bucket to match
 *     the current guess, which is what left drifted rows unhealable before);
 *   - effectiveTypes_ fills it in at REBUILD time for any type whose sheet row
 *     is missing or still unconfigured, so a mapping fix takes effect with no
 *     sheet edit and no API call;
 *   - the Exceptions safety net reads it to stay quiet about types whose money
 *     fields it deliberately does not count (the d: 'ignore' entries below).
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
  '6710': { d: 'income', b: 'Bounties' },    // bounty claimed by you (bounty_reward)
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
  // 'ignore' means the type carries money-ish fields but no money movement of
  // YOURS, so the unmapped-money safety net must stay quiet.
  '6711': { d: 'ignore', b: 'Bounties' },    // your bounty was claimed — the reward
                                             // left the wallet when it was placed (6700)
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
 * log samples. Their whole job here is to keep vault shuffling OUT of the cash
 * tabs: a vault deposit or withdrawal moves money between your wallet and the
 * faction vault, which is a transfer, never income or spending.
 *
 *   6726 "Faction deposit money"        wallet -> vault   (transfer_out)
 *   6736 "Faction give money receive"   vault -> wallet   (transfer_in)
 *   6735 "Faction give money send"      vault -> someone else       (ignore)
 *   6737/6738 "Faction money balance change (send|receive)"         (ignore)
 *   6795 "Faction payout money balance receive" (OC payout)         (ignore)
 *
 * The FactionVault tab's BALANCE is a separate matter and does not come from
 * these logs in this lineage: it is recorded from a manual snapshot (Torn > 10)
 * or from /faction/{id}/balance when the key has Faction API Access — see the
 * Faction vault section of the README. The balance fields the balance-change
 * logs carry are deliberately NOT in MONEY_KEYS, so rebuild can never book a
 * vault rebalance as income or expense.
 *
 * 6735/6737/6738/6795 live in category 80 (Faction), outside the money
 * categories the sync walks, so they are never fetched at all; 6726 (cat 14)
 * and 6736 (cat 17) arrive with the normal categories.
 */
var FACTION_VAULT_IN      = { '6726': true };
var FACTION_VAULT_OUT     = { '6735': true, '6736': true };
var FACTION_VAULT_BALANCE = { '6737': true, '6738': true, '6795': true };

/**
 * File-size control, NOT yet implemented in this lineage: nothing compacts
 * RawLog. The scheme is kept here (and honoured on the reading side — moneyOf_
 * prices a row with no raw JSON from its frozen money column) so that writing
 * the pass later is a self-contained job: once a row is older than
 * RETENTION_DAYS its money is resolved with the CURRENT LogTypeMap (per-type
 * money_key overrides included) and frozen into the money column, then
 * raw_data and the dead datetime/category columns are blanked. Trade legs
 * (4440/4441/4445/4446) keep their raw JSON, as do rows whose money cannot be
 * resolved (exception candidates).
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
