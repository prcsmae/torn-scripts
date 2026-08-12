/**
 * 08_Networth — networth snapshots and the realized/unrealized compare view.
 *
 * Networth is a STOCK (what you own right now); the ledger is a FLOW (money
 * that moved). This file bridges the two:
 *
 *   - Networth tab: an append-only log of Torn's /user/networth, taken on every
 *     sync and on demand. Deduped on Torn's own snapshot timestamp so repeated
 *     runs never duplicate a row.
 *   - Compare tab: per-snapshot realized vs unrealized, so you can see how much
 *     of your networth change came from actual cash (the ledger) vs value
 *     changes of what you hold (stocks, items, ...).
 *
 * Both derived views are rebuilt from source data, so they are idempotent:
 * rebuilding never duplicates rows.
 */

var NETWORTH_HEADERS = ['snapshot_ts', 'date', 'total', 'wallet', 'vault',
  'city_bank', 'cayman_bank', 'inventory', 'bazaar', 'trades', 'item_market',
  'display_case', 'auction_house', 'enlisted_cars', 'stock_market', 'property',
  'company', 'points'];

var COMPARE_HEADERS = ['date', 'networth', 'delta', 'realized', 'unrealized',
  'cum_delta', 'cum_realized', 'cum_unrealized'];

/**
 * Append one networth snapshot from Torn's /user/networth. Skipped when the
 * newest stored snapshot is already at or after Torn's timestamp (Torn only
 * recomputes networth periodically, so most syncs add nothing). Returns 1 if a
 * row was added, 0 if skipped.
 */
function snapshotNetworth_() {
  var j = fetchJson_(API + '/user/networth?key=' + key_());
  var n = j.networth || {};
  var money = n.money || {}, items = n.items || {}, assets = n.assets || {};
  var ts = num_(n.timestamp) || Math.floor(Date.now() / 1000);

  var sheet = tab_(TABS.NETWORTH, NETWORTH_HEADERS);
  if (sheet.getLastRow() > 1) {
    var lastTs = num_(sheet.getRange(sheet.getLastRow(), 1).getValue());
    if (lastTs >= ts) return 0;   // already have this snapshot
  }
  // total is stored as Torn reports it (authoritative). The stored buckets cover
  // every real-money holding; the handful of usually-zero fields (bookie,
  // piggy bank, pending, loans, unpaid fees) are intentionally not captured —
  // the Compare/Dashboard math only ever uses `total`.
  sheet.appendRow([ts, new Date(ts * 1000), num_(n.total), num_(money.wallet),
    num_(money.vault), num_(money.city_bank), num_(money.cayman_bank),
    num_(items.inventory), num_(items.bazaar), num_(items.trades),
    num_(items.item_market), num_(items.display_case), num_(items.auction_house),
    num_(items.enlisted_cars), num_(assets.stock_market), num_(assets.property),
    num_(assets.company), num_(n.points)]);
  return 1;
}

/** Menu entry: take a snapshot now and refresh the derived views. */
function snapshotNetworth() {
  var added = snapshotNetworth_();
  buildCompare_();
  buildDashboard_();
  ss_().toast(added ? 'Networth snapshot added.' : 'No new snapshot (already current).', 'Torn', 6);
}

/** Oldest -> newest networth snapshots as {ts, total}. */
function readNetworthSnapshots_() {
  var sheet = tab_(TABS.NETWORTH, NETWORTH_HEADERS);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
    .filter(function (r) { return num_(r[0]) > 0; })
    .map(function (r) { return { ts: num_(r[0]), total: num_(r[2]) }; })
    .sort(function (a, b) { return a.ts - b.ts; });
}

/**
 * Realized cash in each snapshot window, mirroring rebuild()'s accounting
 * exactly (LogTypeMap direction + moneyOf_), minus TRANSFER_TYPES so money that
 * only moved between networth buckets (bank/vault/offshore/loans) is not
 * counted as income or expense. Returns one number per snapshot (index 0 is
 * always 0 — there is no baseline before the first snapshot).
 */
function realizedPerWindow_(snap, raw, types) {
  var out = [];
  for (var i = 0; i < snap.length; i++) out.push(0);
  if (snap.length < 2) return out;
  raw.forEach(function (r) {
    if (TRANSFER_TYPES[r.logType]) return;
    var t = types[r.logType];
    if (!t || t.direction === 'ignore') return;
    if (!INCOME_DIRS[t.direction] && !EXPENSE_DIRS[t.direction]) return;
    var amt = moneyOf_(r, t);
    if (amt === null) return;
    var signed = INCOME_DIRS[t.direction] ? amt : -amt;
    for (var i = 1; i < snap.length; i++) {
      if (r.ts > snap[i - 1].ts && r.ts <= snap[i].ts) { out[i] += signed; break; }
    }
  });
  return out;
}

/**
 * Rebuild the Compare tab from the Networth and RawLog tabs. Idempotent.
 *
 * Columns: date, networth, delta, realized, unrealized, cumulative versions of
 * the last three. delta = networth[i] - networth[i-1]; realized = what the
 * ledger's cash flow says for that window; unrealized = delta - realized (stock
 * and item value changes, looted value, anything not a cash log). The last row
 * of the cumulative columns is the all-time total.
 */
function buildCompare_() {
  var snap = readNetworthSnapshots_();
  var realized = realizedPerWindow_(snap, readRaw_(), readTypeMap_());

  var rows = [];
  var cumDelta = 0, cumRealized = 0, cumUnrealized = 0;
  for (var i = 0; i < snap.length; i++) {
    var s = snap[i];
    var delta = i ? s.total - snap[i - 1].total : 0;
    var r = i ? realized[i] : 0;
    var u = delta - r;
    cumDelta += delta; cumRealized += r; cumUnrealized += u;
    rows.push([new Date(s.ts * 1000), s.total, delta, r, u,
               cumDelta, cumRealized, cumUnrealized]);
  }

  var sheet = tab_(TABS.COMPARE, COMPARE_HEADERS);
  clearBody_(sheet);
  writeRows_(sheet, rows);
  if (rows.length) {
    sheet.getRange(2, 2, rows.length, 7).setNumberFormat('$#,##0');  // networth..cum
    var data = sheet.getRange(2, 3, rows.length, 6);   // delta .. cum_unrealized
    data.setConditionalFormatRules(cfMoneyRules_(data));
  }
}
