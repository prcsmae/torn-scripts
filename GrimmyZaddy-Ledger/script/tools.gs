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
    'Enter a log type ID (e.g. 1226 for bazaar sell):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var id = resp.getResponseText().trim();
  var log = fetchJson_(API + '/user/log?key=' + key_() + '&log=' + id + '&limit=3').log || [];
  if (!log.length) { ui.alert('No entries found for log type ' + id); return; }

  var title = log[0].details && log[0].details.title;
  var samples = log.slice(0, 3).map(function (e) {
    return JSON.stringify(e.data, null, 2);
  }).join('\n\n---\n\n');
  ui.alert('Log type ' + id + ' — ' + title, samples, ui.ButtonSet.OK);
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
  lines.push('');

  try {
    key_();
    lines.push('API key: found');
  } catch (e) {
    lines.push('API key: ' + e.message);
    ui.alert('Diagnose sync', lines.join('\n'), ui.ButtonSet.OK);
    return;
  }

  MONEY_CATS.forEach(function (cat) {
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
