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
