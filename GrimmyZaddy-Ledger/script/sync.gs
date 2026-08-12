/**
 * 02_Sync — the only code that writes to RawLog (API v2).
 *
 * RawLog is the one irreplaceable tab. Torn's log API cannot be re-walked once the
 * LAST_TS watermark has advanced past a stretch, so a bug here loses data forever
 * while a bug in rebuild costs a single rerun. Change this file carefully.
 *
 * Two passes:
 *   1. Incremental — the newest entries after the LAST_TS watermark. Cheap:
 *      usually one or two requests per category.
 *   2. Backfill — older history below the oldest stored entry, walked over
 *      successive runs with a BACKFILL_TO cursor until every category's true
 *      beginning is reached. This is how a fresh ledger gets its history.
 *
 * Fetched rows are flushed to the sheet incrementally, so even a run that dies
 * on a rate limit or transient error keeps the rows it already pulled (and the
 * watermarks advance to match). fetchJson_ paces calls and retries Torn's
 * error 5 itself.
 *
 * The request is filtered to MONEY_CATS (14 "Money outgoing", 17 "Money incoming",
 * 138 "Vault", 145 "Offshore bank") so every income, expense and transfer entry
 * is captured. The `cat` parameter accepts exactly one category id, so each
 * category is walked separately; the id-based dedupe makes any overlap harmless.
 */
function syncLogs() {
  var props = PropertiesService.getScriptProperties();
  var sheet = tab_(TABS.RAW);
  var nowSec = Math.floor(Date.now() / 1000);

  // Seen IDs + the oldest stored timestamp, read off the sheet so they can never
  // drift from reality.
  var seen = {}, minStored = Infinity;
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues().forEach(function (r) {
      if (!r[0]) return;
      seen[r[9]] = true;
      if (r[0] < minStored) minStored = r[0];
    });
  }

  // A watermark in the future would silently filter out every new log forever —
  // self-heal it. And an EMPTY RawLog must ignore the watermark entirely: a
  // LAST_TS left over from an earlier run would otherwise block downloading the
  // history this fresh sheet is missing.
  var from = Number(props.getProperty('LAST_TS') || 0);
  if (from > nowSec || minStored === Infinity) {
    if (from > nowSec) props.deleteProperty('LAST_TS');
    if (minStored === Infinity) props.deleteProperty('BACKFILL_TO');
    from = 0;
  }

  var rows = [], maxTs = from, runMin = Infinity, added = 0;
  var moreHistory = false, backfillFloor = 0, capped = false;
  var freshRun = minStored === Infinity;   // started with an empty RawLog
  var MAX_PAGES = 20;               // 2,000 entries per category per pass

  function consume(log) {
    var oldest = Infinity, newInPage = 0;
    log.forEach(function (e) {
      if (e.timestamp < oldest) oldest = e.timestamp;
      if (e.timestamp < runMin) runMin = e.timestamp;
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
    return { oldest: oldest, newInPage: newInPage };
  }

  // Persist whatever has been fetched so far. Called after each pass and on any
  // failure — a partial run must keep its progress, never throw it away.
  // advance: also move the LAST_TS watermark. Only safe when the full pass-1
  // walk completed (every category processed): advancing it on a partial run
  // would skip entries of categories that were never walked, and the backfill
  // pass cannot reach them (it only walks below its cursor), so they'd be lost
  // forever.
  function flush(advance) {
    if (!rows.length) return;
    rows.sort(function (a, b) { return a[0] - b[0]; });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    if (advance) props.setProperty('LAST_TS', String(maxTs));
    added += rows.length;
    rows = [];
  }

  try {
    // ---- Pass 1: incremental, newest first ------------------------------
    // capped: history deeper than this run's window remains unfetched.
    MONEY_CATS.forEach(function (cat) {
      var cursorTo = 0;
      for (var page = 0; page < MAX_PAGES; page++) {
        // from = watermark - 1: the docs say from is exclusive (\"after this time\")
        // but the live API is inclusive, so the watermark second must be re-fetched
        // under either behavior. Dedupe makes the overlap harmless.
        var url = API + '/user/log?key=' + key_() + '&cat=' + cat
                + (from && page === 0 ? '&from=' + (from - 1) : '')
                + (cursorTo ? '&to=' + cursorTo : '')
                + '&limit=100';
        var log = fetchJson_(url).log || [];
        if (!log.length) break;
        var r = consume(log);
        if (log.length < 100) break;   // that was the last page
        if (!r.newInPage) break;       // nothing new — already have this stretch
        if (r.oldest <= from) break;   // reached the watermark
        if (page === MAX_PAGES - 1) { capped = true; break; }  // more history below
        cursorTo = r.oldest;           // step further back, dedupe handles the overlap
      }
    });
    flush(true);  // full pass-1 walk — the watermark is the true global newest

    // ---- Pass 2: backfill older history below the oldest stored entry ------
    // BACKFILL_TO is the oldest timestamp fetched so far; each run fetches the
    // window just below it and advances the cursor. Deleted once every category
    // has no entries left (a short or empty page means that category is done).
    var backfillTo = Number(props.getProperty('BACKFILL_TO') || 0);
    if (!backfillTo && capped) {
      var floor = Math.min(minStored, runMin);
      backfillTo = isFinite(floor) ? floor : 0;
    }
    moreHistory = false;
    backfillFloor = backfillTo;

    if (backfillTo > 0) {
      MONEY_CATS.forEach(function (cat) {
        var cursor = backfillTo;
        for (var page = 0; page < MAX_PAGES; page++) {
          var url = API + '/user/log?key=' + key_() + '&cat=' + cat
                  + '&to=' + cursor + '&limit=100';
          var log = fetchJson_(url).log || [];
          if (!log.length) break;
          var r = consume(log);
          if (r.oldest < backfillFloor) backfillFloor = r.oldest;
          if (log.length === 100) moreHistory = true;
          if (log.length < 100) break;     // this category's history is exhausted
          cursor = r.oldest;               // keep walking further back
        }
      });
      if (moreHistory) props.setProperty('BACKFILL_TO', String(backfillFloor));
      else props.deleteProperty('BACKFILL_TO');
    }
    flush(true);  // pass 1 already advanced the watermark correctly
  } catch (e) {
    // A hard failure (e.g. the six-minute cap) must not lose what was fetched,
    // and must not strand the history below it: if a fresh run or a truncated
    // walk ended without reaching the true beginning, remember the deepest
    // fetched timestamp so the next run continues the backfill there. The
    // watermark is NOT advanced: on a mid-pass-1 failure that would skip
    // categories never walked (and backfill can't reach above its cursor).
    flush(false);
    var floor = Math.min(minStored, runMin);
    var f = backfillFloor > 0 ? backfillFloor : (isFinite(floor) ? floor : 0);
    if ((freshRun || capped || moreHistory) && f > 0) {
      props.setProperty('BACKFILL_TO', String(f));
    }
    throw e;
  }

  return added;
}
