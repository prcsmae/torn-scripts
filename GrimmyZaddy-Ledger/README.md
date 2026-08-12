# TornLedger

A Google Apps Script that tracks your Torn City **income and expenses** from the
activity log (API v2). Every money-in event (bazaar / item-market sales, casino
wins, bounties, interest…) lands on the **Income** tab; every money-out event
(bazaar / item-market buys, rent, upkeep, casino losses…) lands on **Expenses**.
A Dashboard answers the only question that matters: what came in, what went out,
and what's left.

## Files

Apps Script puts every `.gs` file in one global namespace. There are no imports or
exports; the numeric prefixes only document the execution path.

| File | Contents |
|---|---|
| `config.gs` | Tab names, API base, money-field candidates, shared helpers |
| `setup.gs` | Tab creation, log-type reference pull, direction/bucket guessing |
| `sync.gs` | `syncLogs` — the only writer to RawLog |
| `parse.gs` | Money extraction from raw log JSON |
| `rebuild.gs` | `rebuild` and the readers that feed it |
| `dashboard.gs` | Income vs expenses summary |
| `tools.gs` | Manual menu helpers for diagnosis |
| `menu.gs` | `runAll`, trigger installation, `onOpen` |
| `private.gs` | **Your API key (gitignored — see below)** |

## Install

1. Create a Google Sheet, then Extensions > Apps Script.
2. Create one script file per entry above and paste in the contents. Delete the
   default `Code.gs`. Duplicate function names across files fail silently, with
   the last loaded winning, so make sure nothing is left over.
3. The API key is already filled in `private.gs` (a full-access key is required
   for `user/log`). Optionally set `TORN_API_KEY` under Project Settings > Script
   Properties to override it. **Never commit `private.gs`** — it is gitignored.
4. Reload the sheet. A "Torn" menu appears.
5. Torn > 1. Setup sheets.
6. Open **LogTypeMap** and set the `direction` column for the log types you care
   about (see below), then Torn > 2. Sync now.
7. Torn > 3. Rebuild, check the Dashboard, then Torn > 4. Install hourly trigger.

## Tabs

Input, edited by you:

- **LogTypeMap** — the control panel. One row per Torn log type: `direction`
  (how it moves money), `bucket` (grouping label), an optional `money_key`
  naming the exact data field that holds the amount, and the source `category`.
  Setup pre-fills directions from Torn's own money categories (see below).

Output, rewritten on every rebuild:

- **Income** — date, title, bucket, amount for every money-in event.
- **Expenses** — the same columns for every money-out event.
- **Exceptions** — logs that could not be interpreted, with a hint on what to fix.
- **Dashboard** — totals, net, and daily averages.

Archive:

- **RawLog** — append-only, never modified. The only irreplaceable data.

## LogTypeMap directions

| Direction | Meaning | Example log types |
|---|---|---|
| `income` | Money in, no item | Casino win, money received, interest |
| `item_out` | Item leaves, money in | Bazaar sell, item market sell |
| `expense` | Money out, no item | Property rent, upkeep, casino lose |
| `item_in` | Item enters, money out | Bazaar buy, item market buy, foreign buy |
| `ignore` | Default. Excluded entirely. | Logins, travel, item use, muggings |

Setup fills directions from Torn's own categorization: every log type in category
14 ("Money outgoing") becomes `expense`, category 17 ("Money incoming") becomes
`income`, everything else stays `ignore`. Torn's word for it beats title guessing.
Treat the result as a head start and confirm each type you care about — you can
flip any row to `ignore` to exclude it. `money_key` is only needed when a log's
amount lives in a field `config.gs` does not already recognise — run Torn > 5.
Inspect a log type to see the actual `data` keys.

## Design rules

**RawLog is the only irreplaceable data.** Torn's log API cannot be re-walked once
the `LAST_TS` watermark has passed a stretch. A bug in `syncLogs` loses history
permanently; a bug in `rebuild` costs one rerun.

**Interpretation happens at rebuild time.** `syncLogs` stores the whole `data`
object as JSON and guesses only cheaply. Everything is re-derived later from that
JSON, which is why a wrong `money_key` is a one-line edit plus a rebuild.

**`rebuild` is total and idempotent.** Every derived tab is cleared and rewritten.
Never append incrementally to one — the duplication looks exactly like real data.

**Fail loudly into Exceptions.** When a log cannot be interpreted, write a row
saying which knob to turn. Clever fallbacks produce plausible wrong numbers, which
are worse than visible gaps. (The old fallback once reported unix timestamps as
flight costs and a user ID as four million of rent.)

## Efficiency

- **API v2 filtered by Torn's money categories.** `syncLogs` requests only
  categories 14 ("Money outgoing"), 17 ("Money incoming"), 138 ("Vault") and
  145 ("Offshore bank"), so every income, expense and transfer entry is captured
  automatically — no per-type mapping is needed for coverage, and nothing
  irrelevant is downloaded or stored.
- **No item reference.** Setup skips Torn's tens-of-thousands-row items list —
  this ledger only needs the money amount and title, which every log carries.
- **Batched sheet I/O** — read a range once, build an array, write once.
- **One request per hour** via the trigger (100/minute is the API limit).

## Conventions

- ES5 throughout: `var`, function declarations, string concatenation.
- Trailing underscore means private, and means it cannot be called from the menu.
- Tab names come from the `TABS` constant, never string literals.
- Run values from sheets and the API through `num_()` before arithmetic.
- Comments explain why, not what.

## Troubleshooting

Start with the Exceptions tab, which flags most self-diagnosable problems with an
actionable message. For raw field shapes, use Torn > 5. Inspect a log type.

**Sync adds 0 entries.** Run Torn > 8. Diagnose sync. It reports the watermark,
whether the API key is present, what the API returns per category, and whether
RawLog row 1 is data instead of headers. The two most common causes:

1. **Stale files in the Apps Script project.** Apps Script loads the last file
   that defines a function name — a leftover `Code.gs` or an old copy of a file
   silently overrides the new one. Delete everything and paste the current files
   fresh (including `private.gs`).
2. **`LAST_TS` in the future.** A watermark past the current time makes the API
   return nothing. Delete `LAST_TS` from Script Properties (or just wait — the
   sync now detects and resets a future watermark itself).

Also confirm you ran Torn > 1. Setup sheets before the first sync, so RawLog has
its header row.

**Old logs are not showing up.** The sync is incremental by design (the watermark
only asks for what's new) but it **backfills history automatically**: with an
empty RawLog it ignores the watermark and walks back from the present, then
continues on each run through a `BACKFILL_TO` cursor until every category's true
beginning is reached. Run Sync now a few times — each run pulls another ~2,000
entries per category further back. Diagnose sync shows whether backfilling is
still in progress (`BACKFILL_TO: not set` means it's done). While backfilling,
prefer manual Sync runs over the hourly trigger: a backfill run can make up to
~160 API requests, which is fine for the daily budget but heavy for the trigger.

**Use a fresh Google Sheet.** The RawLog column layout differs from the older
trading-ledger version of this script (same column count, different meaning), so
a RawLog written by the old version would silently shift under a new rebuild.
Run Setup sheets on a new sheet.

Most wrong numbers are mapping problems in LogTypeMap, not code bugs. A missing
income row is far more often an unmapped log type than a fault in `rebuild`.

## Limits

Read-only API use for spreadsheets is permitted under Torn's rules. Torn allows
100 requests per minute per user; this uses roughly one per hour. Apps Script's
free tier allows 20,000 URL fetches and 90 minutes of trigger runtime per day,
with a hard six-minute cap per execution. A spreadsheet holds 10 million cells.

`user/log` returns 100 entries per call, so `syncLogs` paginates backwards with a
`to` cursor, up to 2,000 entries per run.
