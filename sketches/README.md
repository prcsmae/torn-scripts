# Travel planner UI sketches

Three directions for the planner panel, built to be compared and thrown away. All
three render the **same real snapshot** from one planner run
(`2026-10-12 22:56 local`, airstrip, 18 slots, net 97%, $50M capital), so the
numbers, leave times and buy items are real output, not filler.

Open any of them directly:

```
xdg-open sketches/001-departure-board/index.html
xdg-open sketches/002-route-cards/index.html
xdg-open sketches/003-one-decision/index.html
```

**Design read:** a data-dense decision panel for a Torn player who travels many
times a day, sitting inside torn.com's dark UI. Dials **ENERGY 1 / RHYTHM 1 /
MOTION 1** (a tool, not a landing page). Palette rule for all three: neutral
scale + **one** accent (green = money up and the recommended thing). Amber is
only ever a restock status marker. Red only ever means negative money.

## The stances

| | 001 Departure board | 002 Route cards | 003 One decision |
|---|---|---|---|
| Stance | tool-first, scannable | content-first, readable | action-first, minimal |
| Layout | one row per destination, right-aligned monospace | hero card then peer cards | single column, one answer |
| Settings | chip strip, expands in place | collapsed `details` at the bottom | behind a gear |
| Density | high | medium | low |
| The buy list | row detail, on click | card body, on click | pre-flight checklist you tick off |
| Leave time | column, sortable | inline per card | 44px answer with a live countdown |
| Best on | desktop, many trips a day | phone and desktop alike | Torn PDA, seconds before you tap Travel |
| Weak at | 430px: table scrolls sideways (deliberate, nothing clipped) | least compact for 11 rows | hides the table people already know |

**My take:** 002 is the best default for this script. It keeps every number the
table had, drops the second scroll axis on a phone, and the hero card can carry
the "leave at 02:20 / catch the restock" answer that the current panel buries in
a table column. 003 is the best *PDA* screen if you want one; 001 is the best
desktop power screen, but it is the one that still needs a sideways scroll at
430px. A hybrid (002 cards + 003's countdown in the hero) is probably the real
answer.

## What verification caught

Each variant was loaded in a real browser and driven, not eyeballed:

- **Variant 001's sort detached a row**: `frag.appendChild(tr)` moved the row out
  of the table, so `tr.nextElementSibling` was then `null` and the row was lost in
  the fragment (11 rows became 10 and the console threw). Detail rows are now
  captured before the move.
- **No viewport meta tag** in any variant, so a 430px phone rendered at a 980px
  layout viewport. Added to all three.
- **Tap targets failed R-03**: controls were 22-27px tall. Every control and
  interactive row now clears 44px at `max-width:640px` or `pointer:coarse`,
  desktop density is unchanged.
- **Clickable rows and cards were not keyboard reachable** (R-32). They now carry
  `role`/`tabindex`/`aria-expanded` and answer Enter and Space, with a visible
  focus ring verified by driving real Tab keys through the browser.
- Final state: no console errors, no page-level horizontal overflow at 430px or
  1000px, every interactive element ≥44px on touch, focus rings present, live
  timers ticking.
