/**
 * 05_Dashboard — the summary view.
 *
 * Formulas reference cells by absolute address and assume the exact row order in
 * the rows array below. Adding or removing a row silently breaks every formula
 * under it, so re-derive them all when editing.
 */

/**
 * One question: did money come in, and did money go out? Income and Expenses both
 * use date/title/bucket/amount columns, so the same SUM pattern serves each.
 */
function buildDashboard_() {
  var d = tab_(TABS.DASH);
  d.clear();
  d.getRange('A1').setValue('INCOME vs EXPENSES')
    .setFontWeight('bold').setFontSize(14);

  var rows = [
    ['', ''],                                                               // row 2
    ['THE VERDICT', ''],                                                    // row 3
    ['Total income',    '=IFERROR(SUM(Income!D:D),0)'],                     // row 4
    ['Total expenses',  '=IFERROR(SUM(Expenses!D:D),0)'],                   // row 5
    ['NET',             '=B4-B5'],                                          // row 6
    ['', ''],                                                               // row 7
    ['DAILY RATES', ''],                                                    // row 8
    ['Days tracked',    '=IFERROR(ROUND((MAX(RawLog!A:A)-MIN(RawLog!A:A))/86400,1),0)'], // row 9
    ['Avg daily income', '=IFERROR(B4/B9,0)'],                              // row 10
    ['Avg daily expense','=IFERROR(B5/B9,0)']                               // row 11
  ];

  d.getRange(2, 1, rows.length, 2).setValues(rows);
  d.getRange('A2:A11').setFontWeight('bold');
  d.getRange('B6').setFontWeight('bold');
  d.setColumnWidth(1, 240);
  d.setColumnWidth(2, 200);
}

function rebuildDashboard() {
  buildDashboard_();
  ss_().setActiveSheet(tab_(TABS.DASH));
}
