/**
 * 02_Sync — the only code that writes to RawLog (API v2).
 *
 * RawLog is the one irreplaceable tab. Torn's log API cannot be re-walked once the
 * LAST_TS watermark has advanced past a stretch, so a bug here loses data forever
 * while a bug in rebuild costs a single rerun. Change this file carefully.
 *
 * The request is filtered to MONEY_CATS (Torn categories 14 "Money outgoing" and
 * 17 "Money incoming"), so every income/expense entry is captured automatically —
 * no per-type mapping needed for coverage. The `cat` parameter accepts exactly one
 * category id, so each category is walked separately and the results are merged;
 * the id-based dedupe makes any overlap harmless.
 */

/**
 * Incremental pull of user/log into RawLog, walking backwards with a `to` cursor
 * until it reaches the watermark or runs out of new entries. Deduplicates on
 * Torn's own log hash, so overlapping runs are harmless.
 */
function syncLogs() {
  var props = PropertiesService.getScriptProperties();
  var sheet = tab_(TABS.RAW);
  var from = Number(props.getProperty('LAST_TS') || 0);

  // Seen-ID set, read straight off the sheet so it can never drift from reality.
  var seen = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 10, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      if (r[0]) seen[r[0]] = true;
    });
  }

  var rows = [], maxTs = from;
  var MAX_PAGES = 20;               // 2,000 entries per category per run

  MONEY_CATS.forEach(function (cat) {
    var cursorTo = 0;

    for (var page = 0; page < MAX_PAGES; page++) {
      // from = watermark - 1: the docs say from is exclusive (\"after this time\")
      // but the live API is inclusive, so the watermark second must be re-fetched
      // under either behavior. Dedupe makes the overlap harmless.
      var url = API + '/user/log?key=' + key_()
              + '&cat=' + cat
              + (from ? '&from=' + (from - 1) : '')
              + (cursorTo ? '&to=' + cursorTo : '')
              + '&limit=100';
      var log = fetchJson_(url).log || [];
      if (!log.length) break;

      var oldest = Infinity, newInPage = 0;

      log.forEach(function (e) {
        if (e.timestamp < oldest) oldest = e.timestamp;
        if (seen[e.id]) return;
        seen[e.id] = true;

        var d = e.data || {};
        var det = e.details || {};

        // Item logs nest ids/quantities in an items array — lift the first one.
        var itemId = firstKey_(d, ITEM_KEYS);
        var qty = num_(firstKey_(d, QTY_KEYS));
        if (Array.isArray(d.items) && d.items.length) {
          if (!itemId) itemId = d.items[0].id || d.items[0].item;
          if (!qty) {
            qty = d.items.reduce(function (a, b) { return a + num_(b.qty); }, 0);
          }
        }

        rows.push([
          e.timestamp,
          new Date(e.timestamp * 1000),
          det.id,
          det.category || '',
          det.title || '',
          num_(firstKey_(d, MONEY_KEYS)),
          itemId || '',
          d.item_name || '',
          qty || 1,
          e.id,
          JSON.stringify(d)
        ]);
        newInPage++;
        if (e.timestamp > maxTs) maxTs = e.timestamp;
      });

      if (log.length < 100) break;  // that was the last page
      if (!newInPage) break;        // nothing new — already have this stretch
      if (oldest <= from) break;    // reached the watermark

      cursorTo = oldest;            // step further back, dedupe handles the overlap
      Utilities.sleep(700);         // stay comfortably under 100 requests/minute
    }
  });

  if (rows.length) {
    rows.sort(function (a, b) { return a[0] - b[0]; });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    props.setProperty('LAST_TS', String(maxTs));
  }
  return rows.length;
}
