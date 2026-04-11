# CLAUDE.md — Pillager Tournament Tracker

## Project Overview

A lightweight, zero-dependency, client-side web application that displays live tournament matchup data pulled from a public Google Sheet. It auto-refreshes every 30 seconds and is intended to run on a screen at a live sporting event.

**Tech stack:** Vanilla HTML5 / CSS3 / JavaScript (ES2020+) — no frameworks, no build tools, no package manager.

---

## Repository Structure

```
PillagerTournamentTracker/
├── index.html   # Single-page shell: header, status bar, main content mount
├── app.js       # All application logic (fetch, parse, render, refresh)
└── style.css    # Dark-theme styles, responsive layout, per-court accent colours
```

There are no sub-directories, no configuration files, and no generated artefacts.

---

## Running Locally

Open `index.html` directly in a browser **or** serve the directory with any static HTTP server:

```bash
python -m http.server 8080
# then open http://localhost:8080
```

No installation, compilation, or build step is ever required.

---

## Key Configuration (`app.js` top of file)

| Constant | Value | Purpose |
|---|---|---|
| `SHEET_ID` | `'152jcyxelkCBTir9-U_bcK7D8y1vIvqw1s_FzZ9pCDKY'` | Google Sheets document ID |
| `API_KEY` | `'AIzaSyB3eUXihSpk-5ky9LzeKPS2ytaWjgsTN7o'` | Google Sheets API v4 key |
| `REFRESH_MS` | `60_000` | Auto-refresh interval (ms) |
| `FETCH_TIMEOUT` | `10_000` | Network request timeout (ms) |

To point the tracker at a different sheet, change `SHEET_ID` (and `API_KEY` if the key is scoped to a specific project). The sheet must be shared as "Anyone with the link can view".

---

## Data Flow

```
Google Sheet (public)
      │
      ▼  REST GET via Google Sheets API v4 (/v4/spreadsheets/…/values/{tab})
fetchSheetData()          → resolves with values[][] (2-D array of strings)
      │
      ▼
parseRounds(values)       → calls parseCourts(headers) internally
      │                      returns Array<{ time, matchups[] }>
      ▼
renderAll(rounds)         → calls renderRound → renderMatchup
      │                      writes innerHTML into #tournament-content
      ▼
setStatus(text, state)    → updates status dot + text in the header
```

Auto-refresh is driven by `scheduleRefresh()` (setTimeout chain). Manual refresh is triggered by the "↻ Refresh" button calling `manualRefresh()`.

---

## Google Sheet Column Layout

Column A is **ignored** (reserved for notes/comments).
Column B is the **time-of-day** for each round (displayed verbatim as returned by the sheet, e.g. `9:00 AM`, `9:30 AM`).
Columns C onward define courts. Headers must follow the pattern:

| Columns required |
|---|
| `{Court Name} Team A`, `{Court Name} Score A`, `{Court Name} Team B`, `{Court Name} Score B` |

Courts are sorted numerically by their number. Rows without a time value are skipped.

---

## Code Conventions

- **No frameworks.** Keep all logic in plain vanilla JS. Do not introduce React, Vue, jQuery, or any npm dependency.
- **No build step.** The files must be directly openable in a browser without compilation.
- **Section comments** delimit logical blocks in `app.js` using the `// ── Name ──────` style. Maintain this pattern when adding new sections.
- **HTML generation** is done via template literals in `renderMatchup` / `renderRound`. Keep HTML strings minimal and escape user-provided content appropriately if the sheet content ever becomes untrusted.
- **Error handling** is centralised in `loadData()`. Individual helpers (`fetchSheetData`, `parseRounds`) throw on failure; `loadData` catches and updates the UI.
- **Status states** are one of four string literals: `'live'`, `'loading'`, `'error'`, `'idle'`. The CSS classes `dot-live`, `dot-loading`, `dot-error`, `dot-idle` map 1-to-1.

---

## Styling Conventions (`style.css`)

- Dark GitHub-inspired palette: background `#0d1117`, surface `#161b22`, border `#30363d`, text `#e6edf3` / `#f0f6fc`.
- Per-court accent colours are applied via `.court-N { border-top-color: … }` classes. To add a new court number, add a corresponding rule.
- Responsive breakpoint at `600px` adjusts padding, font sizes, and card minimum widths.
- Animations (status dot pulse) use `@keyframes pulse` — `opacity` only, no layout thrash.

---

## Adding a New Court

1. Add the court columns to the Google Sheet using one of the two supported naming patterns.
2. Add an accent colour rule to `style.css`:
   ```css
   .court-8 { border-top-color: #your-colour; }
   ```
   `courtClass()` in `app.js` extracts the digit automatically, so no JS change is needed.

---

## Changing the Data Source

Replace `SHEET_ID` at the top of `app.js` with the ID of another public Google Sheet (the long string between `/d/` and `/edit` in the sheet URL). Update `API_KEY` if the key is scoped to a different project. The new sheet must follow the same column naming conventions described above.

The `?tab=` URL parameter selects which sheet tab to load (case-sensitive). If omitted, defaults to `'Sheet1'`. Unlike the old gviz endpoint, the Sheets API v4 requires an explicit tab name — ensure the default matches your sheet's actual first tab name.

---

## Testing

A unit test suite lives in `tests/unit.test.mjs`. Run it with:

```bash
node --test tests/unit.test.mjs
```

Verify changes manually:

1. Open `index.html` in a browser with the network tab open.
2. Confirm a `GET` request fires to `sheets.googleapis.com/v4/spreadsheets/…` (no JSONP script tag).
3. Check the status dot transitions: `dot-loading` → `dot-live` on success, `dot-error` on failure.
4. Simulate a network error by temporarily setting `SHEET_ID` to an invalid value and confirm the error message renders.
5. Confirm auto-refresh fires after 30 seconds (watch the "Updated HH:MM" timestamp change).

---

## Deployment

Drop the three files (`index.html`, `app.js`, `style.css`) onto any static host:

- GitHub Pages
- Netlify / Vercel (static deploy, no build command needed)
- Any web server (nginx, Apache, Caddy)
- A local machine with `python -m http.server`

No environment variables, secrets, or server-side logic are needed. The only external call is to `sheets.googleapis.com`.

---

## Git History Summary

| Commit | Description |
|---|---|
| `0344417` | Merge PR #1 (column handling fix) |
| `d75534c` | Format Column B time-of-day values as `9AM` / `9:30AM` |
| `b97764e` | Ignore Column A; treat Column B as match time of day |
| `7cd0fd0` | Initial implementation: Google Sheets-powered tournament tracker |
