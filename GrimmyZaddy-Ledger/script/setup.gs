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
  tab_(TABS.NETWORTH, NETWORTH_HEADERS);
  tab_(TABS.COMPARE, COMPARE_HEADERS);
  tab_(TABS.FVAULT, FACTION_VAULT_HEADERS);

  refreshReference();
  buildCompare_();
  buildDashboard_();
  SpreadsheetApp.getUi().alert(
    'Setup done.\n\nLogTypeMap directions for every money-moving log type are ' +
    'already filled in from Torn\'s own money categories. Review and adjust, ' +
    'then run Torn > 2. Sync now.');
}

/**
 * Pull torn/logtypes into the LogTypeMap tab, preserving your direction edits.
 * Rows that still carry OLD auto-guessed values are healed to the new ones
 * (Abroad bucket, faction-vault transfer directions) — see healLegacyGuesses_.
 *
 * Directions come from Torn's own categorization, not title guessing:
 *   - category 14 ("Money outgoing") -> expense
 *   - category 17 ("Money incoming") -> income
 *   - transfer categories (Vault, Offshore bank) -> expense for deposit/invest,
 *     income for withdraw/interest
 *   - everything else -> ignore
 *
 * Deliberately does NOT fetch torn/items: the ledger only needs the money
 * amount and the log title, both of which every entry carries on its own, and
 * skipping the catalog fetch keeps setup fast. The FlipProfit tab fetches it
 * on demand (Torn > 11) for real item names.
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

  var catNames = categoryNames_();          // catId -> 'Money outgoing', 'Vault'...
  var members = {};                         // catId -> {logTypeId: true}
  MONEY_CATS.forEach(function (c) { members[c] = categoryTypeIds_(k, c); });

  var rows = types.map(function (t) {
    if (existing[String(t.id)]) return existing[String(t.id)];
    var id = String(t.id);
    var dc = directionAndCategory_(id, t.title, members, catNames);
    return [Number(t.id), t.title, dc.direction, guessBucket_(t.title),
            DERIVED_MONEY_KEYS[id] || '', dc.category];
  });
  rows.sort(function (a, b) { return a[0] - b[0]; });
  rows = healLegacyGuesses_(rows);   // fix stale guesses from older code versions

  clearBody_(sheet);
  writeRows_(sheet, rows);
  applyTypeDropdowns_(sheet, rows.length + 1);
}

/** Direction + category label for a log type id, driven by its Torn category. */
function directionAndCategory_(id, title, members, catNames) {
  // Faction vault money movements are tracked by the ledger's vault-balance
  // math (see FACTION_VAULT_* in config.gs) and must never land in Income /
  // Expenses. They also belong to money categories 14/17, so they are keyed on
  // log type id BEFORE the category rules below:
  //   6726 deposit                -> transfer_out (wallet -> vault)
  //   6736 give money receive     -> transfer_in  (vault -> wallet, like a vault withdraw)
  //   6735 give money send        -> ignore       (money left the vault to a THIRD party;
  //                                                your wallet is untouched, the vault math
  //                                                still counts it by log type)
  //   6737/6738 balance change    -> ignore       (vault-internal bookkeeping; the vault
  //                                                math reads balance_after directly)
  //   6795 OC payout balance      -> ignore       (same: the payout lands in the vault
  //                                                balance, never the wallet; the vault
  //                                                math snaps to its balance_after)
  if (FACTION_VAULT_IN[id])      return { direction: 'transfer_out', category: 'Faction' };
  if (id === '6736')             return { direction: 'transfer_in',  category: 'Faction' };
  if (FACTION_VAULT_OUT[id] || FACTION_VAULT_BALANCE[id])
                                return { direction: 'ignore',       category: 'Faction' };
  // The rest of the payout family (send side, wallet variants) never fires for
  // a regular member — the member-side authoritative log is 6795 above. If one
  // ever appears, keep it out of Income/Expenses rather than guess wrong.
  if (/faction payout money/.test(String(title).toLowerCase()))
                                return { direction: 'ignore',       category: 'Faction' };

  // First match in MONEY_CATS order wins — some types belong to more than one
  // money category (e.g. 6012 offshore interest is in 17 and 145).
  var catId = null;
  for (var i = 0; i < MONEY_CATS.length; i++) {
    var c = MONEY_CATS[i];
    if (members[c] && members[c][id]) { catId = c; break; }
  }
  if (catId === null) {
    return { direction: guessDirection_(title), category: '-' };
  }
  var t = String(title).toLowerCase();
  var direction;
  if (catId === 14)               direction = 'expense';
  else if (catId === 17)          direction = 'income';
  // Faction vault moves only shuffle money between your wallet and the faction
  // vault, so they are transfers — never income or spending. Order-independent
  // on 'faction' so word-order variants are caught, matching the heal.
  else if (/faction/.test(t) && /deposit/.test(t))   direction = 'transfer_out';
  else if (/faction/.test(t) && /withdraw/.test(t))  direction = 'transfer_in';
  else if (/deposit|invest/.test(t))    direction = 'expense';   // transfer in
  else if (/withdraw|interest/.test(t)) direction = 'income';    // transfer out
  else                            direction = 'ignore';          // e.g. 'Vault sharing'
  return { direction: direction, category: catNames[catId] || String(catId) };
}

/** id -> true lookup of the log types in one category. */
function categoryTypeIds_(k, catId) {
  var set = {};
  try {
    var types = fetchJson_(API + '/torn/' + catId + '/logtypes?key=' + k).logtypes || [];
    types.forEach(function (t) { set[String(t.id)] = true; });
  } catch (e) { /* degrade to title guessing */ }
  return set;
}

/** catId -> category title, for the LogTypeMap category column. */
function categoryNames_() {
  var map = {};
  try {
    var cats = fetchJson_(API + '/torn/logcategories?key=' + key_()).logcategories || [];
    cats.forEach(function (c) { map[c.id] = c.title; });
  } catch (e) { /* categories stay '-' */ }
  return map;
}

/**
 * Title-based fallback for log types outside the money categories. Deliberately
 * conservative — it leaves most things as 'ignore' so you consciously opt in.
 * (Money types never reach this: their direction comes from their category.)
 */
function guessDirection_(title) {
  var t = String(title).toLowerCase();
  // Finalized trade item legs: items sent/received in a COMPLETED trade. They
  // carry no money, so they get dedicated directions that keep them out of the
  // cash Income/Expenses tabs entirely — the FlipProfit view values them at
  // market price (and at the trade's real money when a money leg is present).
  if (/items (outgoing|incoming)/.test(t)) {
    return /incoming/.test(t) ? 'item_trade_in' : 'item_trade_out';
  }
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
  // Abroad item trades (buy abroad, sell abroad) are their own bucket — they
  // are typically the buy side of a flip, distinct from travel costs.
  if (/abroad/.test(t) && /buy|sell|bought|sold|item|shop/.test(t))  return 'Abroad';
  if (/travel|flight|abroad|airstrip/.test(t))                       return 'Travel';
  if (/pawn|shop/.test(t))                                           return 'Shop';
  if (/market/.test(t))                                              return 'ItemMarket';
  if (/bazaar/.test(t))                                              return 'Bazaar';
  if (/trade/.test(t))                                               return 'Trade';
  if (/crime/.test(t))                                               return 'Crime';
  if (/casino|poker|slots|blackjack|roulette|lottery/.test(t))       return 'Casino';
  if (/vault/.test(t))                                               return 'Vault';
  return 'Other';
}

/**
 * Re-derive the auto-guessed columns on rows that still carry the OLD defaults,
 * so a mapping-code change heals an existing LogTypeMap on the next refresh
 * instead of leaving stale values forever. Only rows holding the exact value
 * the previous guessing produced are touched — anything you edited deliberately
 * is left alone. Already-healed rows no longer match, so it is idempotent.
 */
function healLegacyGuesses_(rows) {
  return rows.map(function (r) {
    var title = String(r[1] || '');
    var t = title.toLowerCase();
    // The old bucket rule sent every 'abroad buy/sell' to Travel (its regex
    // matched on 'abroad'); those now have their own Abroad bucket.
    if (String(r[3] || '') === 'Travel' && guessBucket_(title) === 'Abroad') {
      r[3] = 'Abroad';
    }
    // Faction vault deposit/withdraw used to fall into the generic transfer
    // rules (deposit -> expense, withdraw -> income). They only move money
    // between your wallet and the faction vault — never income or spending.
    if (/faction/.test(t) && /deposit|withdraw/.test(t) &&
        (String(r[2] || '') === 'income' || String(r[2] || '') === 'expense')) {
      r[2] = /deposit/.test(t) ? 'transfer_out' : 'transfer_in';
    }
    // Faction give money RECEIVE used to inherit cat 17 -> 'income' (it was
    // reported as faction vault income). It is money back to your wallet from
    // the vault — a transfer, like a vault withdraw — and the vault-balance
    // math tracks it by log type. (Give SEND and balance changes are also
    // vault movements; their wallets are untouched, so heal to 'ignore'.)
    if (/faction give money receive/.test(t) &&
        (String(r[2] || '') === 'income' || String(r[2] || '') === 'expense')) {
      r[2] = 'transfer_in';
    }
    if ((/faction give money send/.test(t) || /faction money balance change/.test(t) ||
         /faction payout money/.test(t)) &&
        (String(r[2] || '') === 'income' || String(r[2] || '') === 'expense')) {
      r[2] = 'ignore';
    }
    // The finalized trade item legs used to fall through to 'ignore' (they
    // live outside the money categories); they are flip revenue/cost — items
    // sent/received in a completed trade — valued by the FlipProfit view.
    if (/items outgoing/.test(t) && String(r[2] || '') === 'ignore') r[2] = 'item_trade_out';
    if (/items incoming/.test(t) && String(r[2] || '') === 'ignore') r[2] = 'item_trade_in';
    // Log types whose data carries no matchable money field need a derived
    // money_key expression (pot/2 for high-low cash-ins, worth-fees for stock
    // sells). Fill it only when blank so a deliberate override survives.
    var hint = DERIVED_MONEY_KEYS[String(r[0])];
    if (hint && !String(r[4] || '').trim()) r[4] = hint;
    return r;
  });
}

/** In-cell dropdowns for the LogTypeMap direction and bucket columns. */
function applyTypeDropdowns_(sheet, n) {
  if (n < 2) return;
  var dirs = ['income', 'item_out', 'expense', 'item_in',
              'item_trade_in', 'item_trade_out',
              'transfer_in', 'transfer_out', 'ignore'];
  var buckets = ['Abroad', 'Adverts', 'Attacks', 'Auction', 'Bank', 'Bazaar',
                 'Bounties', 'Casino', 'Church', 'Company', 'Crime', 'Faction',
                 'ItemMarket', 'Job', 'Mission', 'Other', 'Property', 'Racing',
                 'Shop', 'Stocks', 'Trade', 'Travel', 'Vault'];
  // allowInvalid keeps the arrow a suggestion while still accepting a custom
  // label you type yourself — the bucket is free-form, not a locked list.
  sheet.getRange(2, 3, n - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(dirs, true)
      .setAllowInvalid(true).setHelpText('How this log type moves money.').build());
  sheet.getRange(2, 4, n - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(buckets, true)
      .setAllowInvalid(true).setHelpText('Grouping label — pick one or type your own.').build());
}
