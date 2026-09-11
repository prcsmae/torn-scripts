# torn

A collection of Torn City tooling: user scripts (GreaseMonkey / Tampermonkey) and
a Google Apps Script ledger.

## Layout

```
.
├── README.md                    # this index
├── GrimmyZaddy-Ledger/          # Google Apps Script income/expense tracker
│   ├── README.md
│   ├── AGENTS.md
│   └── script/*.gs
└── userscripts/                 # standalone browser user scripts
    ├── autoprice.user.js
    ├── foreignstock.user.js
    ├── spudtravel.user.js
    ├── torn-trade-profit.user.js
    └── torn-travel-planner.user.js
```

## User scripts

Install any of these with a user-script manager (Tampermonkey / GreaseMonkey).
They are standalone and independent of each other.

| Script | Description |
|---|---|
| `autoprice.user.js` | Item Market Auto Price — set item prices relative to the current market, with a settings menu |
| `foreignstock.user.js` | Torn Foreign Stock (Modified) — live abroad stock, restock countdowns & travel profit |
| `spudtravel.user.js` | Spud Travel — foreign stock table, profit/hr by country, restock prediction + landing alarms |
| `torn-trade-profit.user.js` | Torn Trade Profit Calculator |
| `torn-travel-planner.user.js` | Torn Travel Planner — profitable travel routes from live abroad prices + market values |

## GrimmyZaddy-Ledger

Google Apps Script that tracks income and expenses from the Torn activity log
(API v2) into a Google Sheet. See its [README](GrimmyZaddy-Ledger/README.md)
for setup. Your API key lives in `GrimmyZaddy-Ledger/script/private.gs`, which
is git-ignored.

## Notes

- `GrimmyZaddy-Ledger/script/private.gs` contains your API key and is never
  committed.
- The user scripts are third-party / modified scripts kept here for personal
  learning and use.