/**
 * 07_Menu — entry points.
 *
 * runAll is the function the hourly trigger calls. Menu items cannot point at names
 * ending in an underscore, so anything wired into onOpen needs a bare name.
 */

function runAll() {
  var n = syncLogs();
  var x = rebuild();
  return { added: n, exceptions: x };
}

function runAllWithToast() {
  var res = runAll();
  var msg = res.added + ' new entries. ';
  msg += res.exceptions ? res.exceptions + ' issues — see Exceptions tab.' : 'No issues.';
  ss_().toast(msg, 'Torn', 8);
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runAll').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('Hourly sync installed.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Torn')
    .addItem('1. Setup sheets', 'setupSheets')
    .addItem('2. Sync now', 'runAllWithToast')
    .addItem('3. Rebuild only (no fetch)', 'rebuild')
    .addItem('4. Install hourly trigger', 'installTrigger')
    .addSeparator()
    .addItem('5. Inspect a log type', 'inspectLogType')
    .addItem('6. Refresh log-type reference', 'refreshReference')
    .addItem('7. Rebuild dashboard', 'rebuildDashboard')
    .addToUi();
}
