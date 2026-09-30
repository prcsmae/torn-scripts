/**
 * 06_Tools — manual helpers run from the Torn menu.
 *
 * None of these are part of the automated hourly run. They exist for diagnosing
 * mappings and for one-off maintenance.
 */

/** Dump a real sample of one log type so you can confirm its `data` keys. */
function inspectLogType() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Inspect log type',
    'Enter a log type ID (e.g. 1226 for bazaar sell, or a list: 8301,8306):',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  // A list is allowed because mapping work usually comes in pairs (a game's bet
  // and its result logs), and each id costs one paced request anyway.
  var ids = String(resp.getResponseText()).split(/[^0-9]+/).filter(function (s) { return s; });
  if (!ids.length) { ui.alert('No log type ID given.'); return; }

  var out = [];
  ids.forEach(function (id) {
    var log = [];
    try { log = fetchJson_(API + '/user/log?key=' + key_() + '&log=' + id + '&limit=3').log || []; }
    catch (e) { out.push('Log type ' + id + ' — ERROR ' + (e.message || e)); return; }
    if (!log.length) { out.push('Log type ' + id + ' — no entries for this account'); return; }
    out.push('Log type ' + id + ' — ' + (log[0].details && log[0].details.title));
    log.slice(0, 3).forEach(function (e) { out.push(JSON.stringify(e.data, null, 2)); });
  });
  ui.alert('Inspect log type', out.join('\n\n---\n\n'), ui.ButtonSet.OK);
}

/**
 * Mapping audit: every log type in RawLog, how many of its rows rebuild can
 * price, and — for each type it cannot — one sample `data` object. This is the
 * paste-me list after a Torn update adds log types, and it is also how a row
 * that may have lost its raw JSON announces itself: unpriced with no sample
 * means the shape cannot be recovered from the sheet at all and has to come
 * from Torn > 5. Inspect a log type.
 *
 * It classifies with effectiveTypes_, the same function rebuild uses, so
 * "unpriced" here means "lands on the Exceptions tab" there — a row that is
 * priced but deliberately ignored (a cashier's check leg, a vault move) is not
 * a problem and is left out.
 */
function auditMappings() {
  var types = effectiveTypes_(readTypeMap_());
  var by = {};
  readRaw_().forEach(function (r) {
    var t = types[r.logType];
    var priced = t && t.direction !== 'ignore' &&
      (INCOME_DIRS[t.direction] || EXPENSE_DIRS[t.direction]) &&
      moneyOf_(r, t) !== null;
    var e = by[r.logType] || (by[r.logType] =
      { title: r.title, direction: (t && t.direction) || '(no row)', key: (t && t.moneyKey) || '',
        rows: 0, unpriced: 0, sample: '' });
    e.rows++;
    if (priced) return;
    e.unpriced++;
    if (!e.sample && r.raw) e.sample = JSON.stringify(parseRaw_(r));
  });

  var ids = Object.keys(by).filter(function (id) { return by[id].unpriced; })
    .sort(function (a, b) { return by[b].unpriced - by[a].unpriced || a - b; });
  var rows = ids.map(function (id) {
    var e = by[id];
    return [Number(id), e.title, e.direction, e.key, e.rows, e.unpriced,
            e.sample || '(no raw JSON left in RawLog — use Torn > 5. Inspect a log type)'];
  });

  var sheet = tab_(TABS.AUDIT, ['log_type', 'title', 'direction', 'money_key',
                                'rows', 'unpriced', 'sample_data']);
  clearBody_(sheet);
  writeRows_(sheet, rows);
  ss_().setActiveSheet(sheet);
  ss_().toast(rows.length
    ? rows.length + ' log type(s) need attention — see ' + TABS.AUDIT + '.'
    : 'Every log type in RawLog is priced.', 'Torn', 8);
}

/**
 * One-shot health check for "sync added 0 entries". Reports the watermark, the
 * key, what the API actually returns per money category, and whether RawLog is
 * shaped correctly. Run it before touching anything else.
 */
function diagnoseSync() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var nowSec = Math.floor(Date.now() / 1000);
  var lines = [];

  var from = Number(props.getProperty('LAST_TS') || 0);
  lines.push('LAST_TS watermark: ' + (from || 'not set'));
  if (from > nowSec) {
    lines.push('  !! In the FUTURE — it blocks every new log. Delete LAST_TS from');
    lines.push('     Script Properties and re-sync.');
  }
  var backfill = Number(props.getProperty('BACKFILL_TO') || 0);
  if (backfill) {
    lines.push('BACKFILL_TO: ' + backfill + ' — older history is still being fetched;');
    lines.push('  each Sync run continues it until the beginning is reached.');
  } else {
    lines.push('BACKFILL_TO: not set (history fully backfilled, or not started)');
  }

  // Read-only row counts: never create tabs from a diagnostic.
  function rows_(name) {
    var s = ss_().getSheetByName(name);
    return s ? Math.max(0, s.getLastRow() - 1) : 0;
  }
  lines.push('RawLog rows: ' + rows_(TABS.RAW));
  var raw = ss_().getSheetByName(TABS.RAW);
  if (raw && raw.getLastRow() >= 1) {
    var first = raw.getRange(1, 1, 1, 3).getValues()[0];
    var isData = typeof first[0] === 'number' && first[0] > 1e9;
    if (isData) {
      lines.push('  !! Row 1 is DATA, not headers — run 1. Setup sheets first, or');
      lines.push('     rebuild will start reading at row 2 and miss it.');
    }
  }
  lines.push('Income rows: ' + rows_(TABS.INCOME));
  lines.push('Expenses rows: ' + rows_(TABS.EXPENSE));
  lines.push('Networth snapshots: ' + rows_(TABS.NETWORTH));
  lines.push('Faction vault snapshots: ' + rows_(TABS.FVAULT));
  lines.push('');

  try {
    key_();
    lines.push('API key: found');
  } catch (e) {
    lines.push('API key: ' + e.message);
    ui.alert('Diagnose sync', lines.join('\n'), ui.ButtonSet.OK);
    return;
  }

  moneyCategoryIds_().forEach(function (cat) {
    try {
      var j = fetchJson_(API + '/user/log?key=' + key_() + '&cat=' + cat + '&limit=1');
      var log = j.log || [];
      var newest = log.length ? log[0].timestamp : 0;
      var hint = '';
      if (!log.length) hint = ' — no entries in this category';
      else if (from && newest <= from) hint = ' — newest is at/before the watermark (nothing new to fetch)';
      lines.push('cat ' + cat + ': API returned ' + log.length + (log.length ? ' (newest ' + newest + ')' : '') + hint);
    } catch (e) {
      lines.push('cat ' + cat + ': ERROR ' + (e.message || e));
    }
  });

  ui.alert('Diagnose sync', lines.join('\n'), ui.ButtonSet.OK);
}
