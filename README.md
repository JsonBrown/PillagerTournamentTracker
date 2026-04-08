# Pillager Tournament Tracker

A lightweight, zero-dependency, client-side web app that displays live tournament matchup data pulled from a public Google Sheet. Auto-refreshes every 30 seconds — designed to run on a screen at a live sporting event.

**Tech stack:** Vanilla HTML5 / CSS3 / JavaScript (ES2020+) — no frameworks, no build tools, no package manager.

## Features

- Live schedule table showing matchups by court and time slot
- Rankings/standings tab with wins, sets, points, and point differential — split by pool when pools are defined
- Team filter to focus on a single team's matches
- Set-by-set score detail popup for multi-set matches
- Dark/light theme toggle with system preference detection
- Custom title and logo loaded from the Google Sheet
- Auto-refresh every 30 seconds with manual refresh button

## Quick Start

Open `index.html` directly in a browser, or serve the directory with any static HTTP server:

```bash
python -m http.server 8080
# then open http://localhost:8080
```

No installation, compilation, or build step required.

## Files

```
PillagerTournamentTracker/
├── index.html   # Single-page shell: header, status bar, main content mount
├── app.js       # All application logic (fetch, parse, render, refresh)
└── style.css    # Dark-theme styles, responsive layout, per-court accent colours
```

## Configuration

At the top of `app.js`:

| Constant | Default | Purpose |
|---|---|---|
| `SHEET_ID` | `'152jcyx…'` | Google Sheets document ID |
| `REFRESH_MS` | `30000` | Auto-refresh interval (ms) |
| `FETCH_TIMEOUT` | `10000` | Network request timeout (ms) |

To point the tracker at a different sheet, change `SHEET_ID` to the ID of another public Google Sheet (the long string between `/d/` and `/edit` in the sheet URL). The sheet must be shared as "Anyone with the link can view".

### Tab Selection

Append `?tab=<sheet name>` to the URL to display a specific sheet tab (case-sensitive). Omitting it selects the first tab.

## Google Sheet Format

### Column A — Sheet Options

Column A is reserved for sheet-level configuration. The tracker reads the first three rows of Column A on every load:

| Cell | Expected value | Effect |
|------|----------------|--------|
| A1 | Tournament name (text) | Sets the page heading and browser tab title |
| A2 | Logo image URL (text) | Displays a logo in the header; leave blank to show no logo |
| A3 | `TRUE` | Hides the Rankings/Standings tab (any other value or blank = show tab) |

Cells A4 and below in Column A are ignored.

### Column B — Round Time

Column B holds the time-of-day for each round (e.g. `9AM`, `9:30AM`).
Columns C onward define courts using this header pattern:

```
{Court Name} Team A | {Court Name} Score A | {Court Name} Team B | {Court Name} Score B
```

Rows without a time value in column B are skipped.

**Scores** can be a plain number representing sets won (e.g. `2`) or a comma-separated list of individual set scores (e.g. `25,25,15`) for full per-set tracking. A plain number is never treated as points — it is always a set count.

### Pool Assignments

To assign a team to a pool, append `(P#)` to the team name in the sheet — for example `Sharks (P1)` or `Tigers (P2)`. Teams without a pool suffix are treated as belonging to an open/default pool.

When any teams have pool designations, the Rankings tab splits into separate sections — one per pool — each with its own rankings. Teams without a designation are grouped together in an "Open Pool" section at the bottom. If all teams are in the same pool (or none have a designation), no section headers are shown and rankings appear as a single table.

The `(P#)` suffix is stripped from team names everywhere they are displayed; it is used only for grouping.

## Adding a New Court

1. Add the court columns to the Google Sheet.
2. Add an accent colour rule to `style.css`:
   ```css
   .court-8 { border-top-color: #your-colour; }
   ```
   No JS change needed — `courtClass()` extracts the digit automatically.

## Deployment

Drop the three files onto any static host:

- GitHub Pages
- Netlify / Vercel (static deploy, no build command needed)
- Any web server (nginx, Apache, Caddy)
- Local machine with `python -m http.server`

No environment variables, secrets, or server-side logic required. The only external call is to `docs.google.com`.
