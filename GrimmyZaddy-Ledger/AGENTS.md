<!-- agents-md:auto:begin -->
## Project Overview

### File tree (top 3 levels)
```
script/tools.gs
script/sync.gs
script/networth.gs
script/menu.gs
script/dashboard.gs
script/setup.gs
script/rebuild.gs
script/parse.gs
script/config.gs
README.md
```

### Tooling
- (none detected)

### Recent history (last 20 commits)
```
7f40ed8 chore: setup
8537ee8 feat: allocate buy quantities against learned depletion rates
2fec6a9 fix: derived money_key for logs with no direct money field (high-low cash-in pot/2, stock sells net of fees)
e5b0547 fix: setConditionalFormatRules is Sheet-level, not Range-level
6a127ac feat: track faction vault balance (manual snapshots + auto when API access granted)
49ffb73 feat: networth snapshots, realized vs unrealized compare, comprehensive dashboard
8b30e4c fix: pace API calls and survive Torn's rate limit without losing data
600de22 fix: backfill old history so a fresh ledger gets more than just new logs
5280d77 feat: track vault/offshore transfers; self-heal sync; add diagnose tool
19d0e7b feat: filter sync by Torn money categories; derive directions from category endpoints
82e419f fix: make sync watermark immune to from/to boundary semantics
d1dfed3 feat: rewrite GrimmyZaddy-Ledger as income/expense tracker on Torn API v2
ccee9c4 fix: exclude in-stock items that sell out before you finish buying
1d6fc85 fix: restock timing accuracy + depletion-aware buy quantities
b03e98e fix: show actual Torn API error instead of generic 'key error'
7dbb678 fix: add API rate-limit backoff to travel planner
999cafd fix: restock survival check in landingAvailability
1054a1b chore: remove nested .git.bak artifacts, add to .gitignore
c622daa fix: add .user.js extension to autoprice
2aa8b62 Add Torn Trade Profit Calculator userscript
```

## Git & Commit Policy (MANDATORY)

- Git must always be considered and used: check `git status` / `git diff` before starting work,
  and commit every completed change.
- Commit messages MUST follow Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`,
  `docs:`, `test:`, `style:`, `perf:`, `build:`, `ci:`.
- Subject line only — no description/body required.
- Commit as the repository's configured git identity (`git config user.name` / `user.email`).
  Never create or switch identities.
- No AI attribution: no `Co-authored-by:` trailers, no "Generated with ..." lines, no signature
  blocks. Messages should read like a normal, human-written commit.

<!-- agents-md:auto:end -->

