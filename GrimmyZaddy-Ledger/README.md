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
| `dashboard.gs` | Comprehensive summary (flows + networth + compare) |
| `networth.gs` | Networth snapshots, realized/unrealized compare, faction vault |
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
  naming the exact data field that holds the amount — or a tiny derived
  expression: `field/2` (halved, floored), `field-other` (a difference), or
  `field1?field2` (a net with fallback: `field1-field2` when field1 exists,
  else `-field2` — the casino rule). Setup pre-fills the derived keys for the
  log types that need them (high-low cash-in pays `pot/2`, stock sells pay
  `worth-fees`, hunting nets `income-cost`, bank interest is recognized once
  as `worth-amount` when the investment is made, every casino game nets
  `won_amount?bet_amount`), and `REFERENCE_LOGMAP` fills a verified
  direction/bucket/money_key for the money-bearing log types outside the core
  money categories (crime income and costs, muggings, missions, dividends,
  job/company specials, property rent/upkeep/sales, bounties, faction payday,
  points-market trades — the same field-by-field mapping the TornCashflow
  userscript is built on). A derived `money_key` is authoritative: when the
  data lacks its fields the row goes to Exceptions instead of being re-guessed
  (a casino loss can never fall back to being booked as a win). The
  `direction` and `bucket` columns have in-cell dropdowns — pick a label or type
  your own — and every edit you make survives re-running setup; only clearly
  stale auto-guesses are healed automatically (reference and derived values
  are only applied while a row still holds the exact auto-guess). `bucket` is
  what the Dashboard's income-by-source and expenses-by-category rankings
  group by.

Output, rewritten on every rebuild:

- **Income** — date, title, bucket, amount for every money-in event.
- **Expenses** — the same columns for every money-out event.
- **Exceptions** — logs that could not be interpreted, with a hint on what to fix.
- **Networth** — append-only snapshots of Torn's `/user/networth`, taken on every
  sync and via Torn > 9. Snapshot networth. One row per recomputation (deduped on
  Torn's own timestamp): total, wallet, vault, city/cayman bank, inventory,
  bazaar, trades, item market, stocks, property, company, points.
- **FactionVault** — append-only snapshots of your personal faction vault
  balance (`[ts, date, balance, source]`). Recorded manually via Torn > 10.
  Snapshot faction vault (enter what you see on Faction > Vault), auto-fetched
  from `/faction/{id}/balance` whenever the key has Faction API Access
  (`source: api`), and — with **no API access at all** — maintained from the
  logs once you have one snapshot (`source: derived`). One manual snapshot
  seeds the balance; from then on every sync folds the vault movements in
  RawLog into it: deposits (6726) add, gives (6735/6736) subtract, and a
  balance-change log for you (6737/6738, which carries your exact
  `balance_after`) jumps straight to Torn's number. A fresh manual snapshot
  re-anchors at any time.
- **Compare** — per-snapshot `Δ networth`, split into **realized** (cash the
  ledger actually saw — income minus expenses, mirroring rebuild's accounting
  minus transfers) and **unrealized** (the rest: stock and item value changes,
  looted value). Cumulative columns on each row; the last row is the all-time
  total.
- **FlipProfit** — per-item profit/loss for items you bought abroad (your flip
  stock): units bought and sold, buy cost, sell revenue, profit and ROI per
  item, ranked best-first with a bold totals row and green/red profit cells.
  A **Buy sources** column splits each item's cost by where it was bought
  (Abroad, Bazaar, ItemMarket, Trade, …) so you can see which buying channel
  actually carries your flips. Any item with an abroad purchase is included;
  cost and revenue count every ledgered buy and sale of that item (so
  item-market purchases of the same item count too), and failed trades are
  ignored. Rebuilt with the dashboard.
  Item names are resolved from Torn's item reference (Torn > 11, or
  automatically on the first build) — Torn's logs only carry numeric item IDs.
  **Trades count at their real cash value.** Items sent in a completed trade
  ("Trade items outgoing") earn the money that trade actually brought in, and
  items received ("Trade items incoming") cost the money the trade paid out —
  matched by trade id, and split across a multi-item trade by market value.
  A trade that moved no money (a pure item swap) values at 0 until those items
  are sold — market price is never used to invent a profit. The trade money
  legs (4441/4440) also appear in Income/Expenses as ordinary cash, because
  the sync already fetches their categories (14/17).
  Caveats: items you received for free and later sold are invisible to the
  ledger, which makes that item's profit look higher than it is; stock bought
  abroad but not yet sold shows as a loss — it's capital on hand.
- **ItemNames** — cached copy of Torn's item id→name reference (the full item
  catalog) plus each item's current market price and Torn's item `type` (  Drug, Candy, …). Fetched via Torn > 11. Fetch item names (or automatically
  the first time the flip table builds with none stored, or when a tab written
  before the type column existed is detected). Used to show real item names on
  the FlipProfit tab and to group the CashFlow tab's spending by item type; the
  market price is used ONLY to split a trade's real money across a multi-item
  trade — never to value anything.
- **Dashboard** — a bottom-line income/expenses/net total with a status badge,
  a **today** snapshot (live income/expenses/net totals plus the day's top
  three income sources and expense categories, computed at build time) and a
  **last-7-days** snapshot (live formulas), income and expenses ranked by
  bucket (Bazaar, ItemMarket, Trade, Casino, …) with the **best cash flow**
  and **worst spending** named in the section titles and tinted green/red, a
  **Savings & transfers** section for bank/vault/offshore/loan moves (kept out
  of the rankings — they only shuffle money between your own accounts — but
  shown so every dollar reconciles), a day-by-day income/expenses/net table
  for the last 14 days, the latest networth snapshot, the latest and all-time
  realized/unrealized split, and long-run daily averages. Money cells are
  color-coded by sign: green = gain, red = loss, gray = flat.
- **Today** — the day's full activity as a readable log, rebuilt with the
  dashboard: every RawLog row from today, newest first, with its bucket,
  direction (IN = money in, OUT = money out, TRF = transfer-direction row —
  faction vault moves that never count toward income/expense, — = notification),
  item, quantity and a signed amount (+ in / − out), plus the same live
  income/expenses/net-today totals as the Dashboard. Bank/vault/offshore
  deposits & withdrawals carry IN/OUT and are part of the totals (they're in
  the Income/Expenses tabs), but stay out of the Dashboard rankings. Rows
  without a money-bearing direction show no amount.
- **CashFlow** — the complete money picture the Dashboard's top-6 rankings
  leave out. Four sections, rebuilt with the dashboard: **Spending by item**
  (every item you paid cash for — bazaar, item-market, shop and abroad buys —
  ranked by total, with quantity and where you bought it: this is where
  happy-jump consumables like Xanax, LSD, ecstasy, candies and erotic DVDs
  show up, since the flip table only tracks abroad-bought stock),
  **Spending by item type** (the same money grouped by Torn's item type —
  Drug, Candy, … — so energy vs happy vs everything else is one glance),
  and **Expenses / Income by bucket** (the full ranked bucket lists with each
  bucket's share, where the Dashboard shows only the top six). Trade-ins are
  excluded from the item views — an item received in a trade cost no cash out
  of the wallet — and bank/vault/offshore transfers are excluded throughout
  (they are on the Dashboard under Savings & transfers).

Archive:

- **RawLog** — append-only: rows are never deleted, and every row is kept
  forever. To stop the file growing with history, rows older than 90 days are
  *compacted* in place (see Efficiency): their money is frozen into a plain
  number and the bulky raw JSON plus dead columns are dropped, so the sheet
  stays small while the views stay exactly as accurate. The only irreplaceable
  data.

## LogTypeMap directions

| Direction | Meaning | Example log types |
|---|---|---|
| `income` | Money in, no item | Casino win, money received, interest |
| `item_out` | Item leaves, money in | Bazaar sell, item market sell |
| `expense` | Money out, no item | Property rent, upkeep, casino lose |
| `item_in` | Item enters, money out | Bazaar buy, item market buy, abroad buy |
| `item_trade_out` | Items SENT in a completed trade (no cash in the log itself) | Trade items outgoing |
| `item_trade_in` | Items RECEIVED in a completed trade (no cash in the log itself) | Trade items incoming |
| `transfer_in` | Money back to your wallet from storage | Vault/offshore/faction-vault withdraw |
| `transfer_out` | Money parked in storage, out of your wallet | Bank invest, vault/faction-vault deposit |
| `ignore` | Default. Excluded entirely. | Logins, travel, item use, muggings |

Setup fills directions from Torn's own categorization: every log type in category
14 ("Money outgoing") becomes `expense`, category 17 ("Money incoming") becomes
`income`. Vault and offshore transfers (categories 138/145) get `income` when
money comes back to your wallet (withdraw/interest) and `expense` when it is
parked (deposit/invest). Faction vault deposit/withdraw are always
`transfer_out`/`transfer_in` — they only move money between your wallet and the
faction vault, so they never count as income or spending. Everything else stays
`ignore`. Torn's word for it beats title guessing. Treat the result as a head
start and confirm each type you care about — you can flip any row to `ignore` to
exclude it, or change its `bucket` to regroup it (see Buckets below).
`money_key` is only needed when a log's amount lives in a field `config.gs` does
not already recognise — run Torn > 5. Inspect a log type to see the actual
`data` keys.

The two trade item legs (4445/4446) are mapped to `item_trade_out`/`item_trade_in`
— they carry no money of their own, so they must never land in Income/Expenses
as cash. They stay out of the cash tabs entirely; the FlipProfit view values
them at the real money their trade moved (see the FlipProfit section above).

### Buckets

The `bucket` column groups a log type for the Dashboard's ranked
income-by-source and expenses-by-category tables. Defaults cover the big money
sources — Bazaar, ItemMarket, Trade, Casino, Crime, Property, Job, Travel,
**Abroad** (items bought/sold while traveling — your flip stock — kept separate
from travel costs), Bank, Vault, Faction, … — with `Other` as the catch-all.
The dropdown also suggests `Company` for paycheck log types, and you can type
any custom label (the dropdown allows it) — change any bucket cell and rebuild
(Torn > 3) to regroup history.

## Networth vs ledger

These are two different questions:

- **Ledger = flow.** `NET` is every dollar that came in minus every dollar that
  went out, summed over your whole tracked history. It has no opening balance.
- **Networth = stock.** What you own right now — cash, items, stocks, property.

That's why `NET` never matches your wallet balance: the surplus went into assets
(the ledger counts the cash out when you buy them and cash in when you sell; it
never knows their current value). The Compare tab reconciles them per snapshot:

    Δ networth = realized + unrealized

where **realized** is the cash the ledger saw in the window and **unrealized** is
value changes of what you hold (stock prices, item values). For the equation to
balance, transfers that only move money between networth buckets — bank
invest/withdraw, vault, offshore bank, loans (`TRANSFER_TYPES` in config.gs) —
are excluded from realized; interest earned still counts as income. Company and
bookie deposits are deliberately left out: networth's treatment of those balances
is ambiguous, and they only shift the split, never the total.

One timing note: Torn's networth carries its own compute timestamp, which can lag
"now" by up to ~30 minutes. A snapshot window's realized/unrealized therefore
covers activity up to that compute time — recent minutes show up in the *next*
window, not a bug.

## Faction vault

The faction vault is **not** part of Torn's networth total, so it is tracked
separately (the Dashboard shows it right below the networth breakdown). There
are three ways the balance is recorded, in priority order:

1. **Log-derived (`source: derived`) — no permission needed.** Every vault
   movement is already a log: `Faction deposit money` (6726) adds,
   `Faction give money send/receive` (6735/6736) subtract, and the balance
   logs — `Faction money balance change` (6737/6738) and `Faction payout
   money balance receive` (6795, organized-crime payouts) — carry your exact
   `balance_after`, which is authoritative. Take ONE manual snapshot to seed
   the balance (Torn > 10), and every sync after that maintains it from the
   logs — the FactionVault tab grows a `derived` row whenever the balance
   changes. The Dashboard's vault line follows automatically.
   Note on the balance logs: their `user` field is the **banker** who
   performed the change (anyone with vault access — it is not your ID), so a
   balance log in your own feed is always about *your* balance and its
   `balance_after` applies unconditionally.
   The derived math is **self-healing**: it anchors on the *newest*
   authoritative number — the latest balance log's `balance_after`, or a
   fresh manual snapshot taken after it (your re-anchor) — never on a
   previously computed `derived` row. So even if an old build left a wrong
   derived row in the tab, the next sync recomputes from the newest balance
   log and appends the corrected value.
2. **Manual (`source: manual`)** — open Faction > Vault, read your balance,
   Torn > 10. Snapshot faction vault, paste the number (commas/`$` are fine).
   Any manual snapshot re-anchors the derived math, so you can correct drift
   any time.
3. **API (`source: api`)** — if your key has **Faction API Access** (granted
   by the faction leader), `/faction/{id}/balance` is fetched on every sync
   and is authoritative; while it works, the derived path stands down.

The vault flow logs (6735 give send, 6737/6738 balance change, 6795 OC
payout balance) live in category 80, outside the money categories, so the
sync fetches them with a standalone `log=` selection; deposits (6726, cat 14)
and gives received (6736, cat 17) already come through the normal categories.

Faction vault deposits and withdrawals are transfers (see LogTypeMap directions
above): they appear in the Dashboard's **Savings & transfers** section — never
as income or expenses. Give-send, balance-change and payout logs are `ignore`
(money left the vault to a third party, stayed inside it, or landed in the
vault balance as an OC payout — your wallet was never touched), and give-receive
maps to `transfer_in`, like a vault withdraw.

## Design rules

**RawLog is the only irreplaceable data.** Torn's log API cannot be re-walked once
the `LAST_TS` watermark has passed a stretch. A bug in `syncLogs` loses history
permanently; a bug in `rebuild` costs one rerun.

**Interpretation happens at rebuild time.** `syncLogs` stores the whole `data`
object as JSON and guesses only cheaply. Everything is re-derived later from that
JSON, which is why a wrong `money_key` is a one-line edit plus a rebuild. The one
exception is compaction: rows older than `RETENTION_DAYS` (default 90) have
their money resolved with the *current* LogTypeMap and frozen into the money
column, after which their raw JSON is dropped — so a `money_key` change made
*after* a row is compacted no longer re-derives that row. Fresh rows keep their
full JSON, so the fix-without-re-download promise still holds for everything
recent.

**`rebuild` is total and idempotent.** Every derived tab is cleared and rewritten.
Never append incrementally to one — the duplication looks exactly like real data.

**Fail loudly into Exceptions.** When a log cannot be interpreted, write a row
saying which knob to turn. Clever fallbacks produce plausible wrong numbers, which
are worse than visible gaps. (The old fallback once reported unix timestamps as
flight costs and a user ID as four million of rent.)

## Efficiency

- **API v2 filtered by money categories.** `syncLogs` walks categories
  14 ("Money outgoing"), 17 ("Money incoming"), 138 ("Vault") and
  145 ("Offshore bank") plus the money-bearing categories Torn keeps outside
  them — crimes, muggings, casino games, hunting, missions, dividends, job
  specials, faction payday, property, bounties and more
  (`EXTRA_MONEY_CAT_NAMES`, resolved to ids from `/torn/logcategories` and
  cached for 7 days). Coverage of those extra categories is per-type via
  `REFERENCE_LOGMAP` (verified against live log dumps). Each category's full
  history is backfilled once and recorded in `BACKFILLED_CATS`, so categories
  added in a later update are walked without re-walking the originals. The two
  finalized trade item legs (4445/4446) are fetched with a standalone
  `log=4445,4446` selection; trade money legs (4440/4441) are already covered
  by categories 14/17.
- **No item reference at setup.** Setup skips Torn's item catalog — the ledger
  only needs the money amount and title, which every log carries. The
  FlipProfit tab optionally fetches it once (Torn > 11, or automatically on
  first use) so the flip table can show real item names.
- **Batched sheet I/O** — read a range once, build an array, write once.
- **Rate-limit safe.** Every API call is paced to ~60/minute (the limit is 100)
  and Torn's "too many requests" error is retried automatically after the window
  clears, so a backfill run survives traffic spikes. Fetched rows are written
  progressively, so even a run that hits the six-minute cap keeps its progress.
- **One request per hour** via the trigger (plus one paced `/user/networth` call
  per sync for the snapshot).
- **Old rows are compacted, not deleted.** RawLog grows forever, so the file
  would too: once a row is older than `RETENTION_DAYS` (default 90, config.gs)
  its money is resolved with the current LogTypeMap (per-type `money_key`
  overrides included) and frozen into the money column, then the bulky raw JSON
  and the dead datetime/category columns are blanked — the views read the
  frozen money, so every number stays exactly as accurate, and the sheet
  payload shrinks by the bulk of the JSON. Trade legs (4440/4441/4445/4446)
  keep their raw JSON (`parsed_trade_id` is load-bearing for the flip view), as
  do rows whose money cannot be resolved (they are exception candidates).
  Compaction runs automatically once RawLog passes `COMPACT_AT_ROWS` rows
  (default 20,000), or on demand via Torn > 14. Compact old logs; it is
  idempotent, so an interrupted run is finished by the next one.

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

**FlipProfit sells from trades are missing.** The sync fetches the finalized
item legs automatically; check that LogTypeMap maps "Trade items outgoing" /
"Trade items incoming" to `item_trade_out`/`item_trade_in` — run Torn > 6.
Refresh log-type reference to heal rows added as `ignore`, then Torn > 2. Sync
now (the first sync after the update walks the trade history below the
watermark once). The flip table values traded items at the real money their
trade moved; a trade with no money leg values at 0, and the money legs
(4441/4440) show in Income/Expenses as normal cash.

**Abroad item buys show as Travel / faction vault withdraw counts as income.**
Those are legacy auto-guesses from older code versions. Run Torn > 6. Refresh
log-type reference — it heals rows that still hold the old defaults — then
Torn > 3. Rebuild only. Fresh setups never have the problem.

**First syncs after the money-categories update are heavier.** The extra
categories (crimes, casino, property, ...) are backfilled like the originals:
a few Sync runs, each pulling up to ~2,000 entries per category, with at most
six not-yet-backfilled categories started per run to stay inside the six-minute
cap. Diagnose sync lists every category being walked. Casino entries land as
net income rows (a loss is a negative income row, not an expense), bank
interest appears once at invest time as `worth-amount`, and unmapped
money-category logs surface on the Exceptions tab.

Most wrong numbers are mapping problems in LogTypeMap, not code bugs. A missing
income row is far more often an unmapped log type than a fault in `rebuild`.

## Limits

Read-only API use for spreadsheets is permitted under Torn's rules. Torn allows
100 requests per minute per user; this uses roughly one per hour. Apps Script's
free tier allows 20,000 URL fetches and 90 minutes of trigger runtime per day,
with a hard six-minute cap per execution. A spreadsheet holds 10 million cells.

`user/log` returns 100 entries per call, so `syncLogs` paginates backwards with a
`to` cursor, up to 2,000 entries per run.
