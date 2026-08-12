/**
 * 05_Dashboard — the comprehensive summary view.
 *
 * Income/Expenses rows are live formulas; the Networth and Compare rows read the
 * latest values from those tabs (the C2:C / INDEX pattern avoids ever returning
 * a header text cell). Money cells are color-coded by sign through conditional
 * formatting (green = gain, red = loss, gray = flat), re-applied on every
 * rebuild because clear() wipes conditional formatting.
 *
 * Layout is fully script-written: every section stays in sync with the data and
 * the row order below must not be edited casually.
 */

function buildDashboard_() {
  var d = tab_(TABS.DASH);
  d.clear();

  var rows = [
    ['TORN LEDGER — INCOME vs EXPENSES', ''],
    ['Total income', '=IFERROR(SUM(Income!D:D),0)'],                                 // row 2
    ['Total expenses', '=IFERROR(SUM(Expenses!D:D),0)'],                             // row 3
    ['NET (all cash that moved)', '=B2-B3'],                                         // row 4
    ['Status', '=IF(B4>0,"▲ PROFITABLE",IF(B4<0,"▼ LOSING","— FLAT"))'],            // row 5
    ['', ''],                                                                        // row 6
    ['NETWORTH — latest snapshot', ''],                                              // row 7
    ['Networth total', '=IFERROR(INDEX(Networth!C2:C,COUNTA(Networth!C2:C)),0)'],    // row 8
    ['Cash (wallet + vault)', '=IFERROR(INDEX(Networth!D2:D,COUNTA(Networth!D2:D))+INDEX(Networth!E2:E,COUNTA(Networth!E2:E)),0)'], // row 9
    ['City bank', '=IFERROR(INDEX(Networth!F2:F,COUNTA(Networth!F2:F)),0)'],         // row 10
    ['Cayman bank', '=IFERROR(INDEX(Networth!G2:G,COUNTA(Networth!G2:G)),0)'],       // row 11
    ['Items (inventory)', '=IFERROR(INDEX(Networth!H2:H,COUNTA(Networth!H2:H)),0)'], // row 12
    ['Bazaar', '=IFERROR(INDEX(Networth!I2:I,COUNTA(Networth!I2:I)),0)'],            // row 13
    ['Stock market', '=IFERROR(INDEX(Networth!O2:O,COUNTA(Networth!O2:O)),0)'],      // row 14
    ['Property', '=IFERROR(INDEX(Networth!P2:P,COUNTA(Networth!P2:P)),0)'],          // row 15
    ['Faction vault', '=IFERROR(INDEX(FactionVault!C2:C,COUNTA(FactionVault!C2:C)),0)'], // row 16
    ['Δ Faction vault', '=IFERROR(INDEX(FactionVault!C2:C,COUNTA(FactionVault!C2:C))-INDEX(FactionVault!C2:C,COUNTA(FactionVault!C2:C)-1),0)'], // row 17
    ['', ''],                                                                        // row 18
    ['SINCE PREVIOUS SNAPSHOT', ''],                                                 // row 19
    ['Δ Networth', '=IFERROR(INDEX(Compare!C2:C,COUNTA(Compare!C2:C)),0)'],          // row 20
    ['Realized (cash in/out)', '=IFERROR(INDEX(Compare!D2:D,COUNTA(Compare!D2:D)),0)'], // row 21
    ['Unrealized (value change)', '=IFERROR(INDEX(Compare!E2:E,COUNTA(Compare!E2:E)),0)'], // row 22
    ['', ''],                                                                        // row 23
    ['ALL-TIME SINCE FIRST SNAPSHOT', ''],                                           // row 24
    ['Δ Networth', '=IFERROR(INDEX(Compare!B2:B,COUNTA(Compare!B2:B))-INDEX(Compare!B2:B,1),0)'], // row 25
    ['Realized (cash)', '=IFERROR(SUM(Compare!D2:D),0)'],                            // row 26
    ['Unrealized (value)', '=IFERROR(SUM(Compare!E2:E),0)'],                         // row 27
    ['', ''],                                                                        // row 28
    ['DAILY RATES', ''],                                                             // row 29
    ['Days tracked', '=IFERROR(ROUND((MAX(RawLog!A:A)-MIN(RawLog!A:A))/86400,1),0)'], // row 30
    ['Avg daily income', '=IFERROR(B2/B30,0)'],                                      // row 31
    ['Avg daily expense', '=IFERROR(B3/B30,0)'],                                     // row 32
    ['Avg daily net', '=IFERROR(B4/B30,0)']                                          // row 33
  ];

  d.getRange(1, 1, rows.length, 2).setValues(rows);

  // Section titles: bold on a tinted bar.
  [1, 7, 19, 24, 29].forEach(function (r) {
    d.getRange(r, 1).setFontWeight('bold').setBackground('#cfe2f3');
  });
  d.getRange(1, 1).setFontSize(14);
  d.getRange('A1:A33').setFontWeight('bold');

  // Money cells get a currency format.
  [2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 22, 25, 26, 27, 31, 32, 33]
    .forEach(function (r) { d.getRange(r, 2).setNumberFormat('$#,##0'); });

  d.setColumnWidth(1, 240);
  d.setColumnWidth(2, 200);

  // Color coding by status: gains green, losses red, zero flat.
  var moneyRanges = [4, 17, 20, 21, 22, 25, 26, 27, 33]
    .map(function (r) { return d.getRange(r, 2); });
  d.getRange(4, 2).setConditionalFormatRules(cfMoneyRules_(moneyRanges));

  var status = d.getRange(5, 2);
  status.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('▲ PROFITABLE').setBackground(CF_COLORS.pos).setRanges([status]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('▼ LOSING').setBackground(CF_COLORS.neg).setRanges([status]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('— FLAT').setBackground(CF_COLORS.neutral).setRanges([status]).build()
  ]);
}

function rebuildDashboard() {
  buildCompare_();
  buildDashboard_();
  ss_().setActiveSheet(tab_(TABS.DASH));
}
