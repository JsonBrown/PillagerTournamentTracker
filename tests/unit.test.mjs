/**
 * Unit tests for app.js — pure / stateless functions.
 *
 * Uses only Node.js built-ins: node:test, node:assert, node:vm, node:fs, node:path.
 * No npm install required.
 *
 * Run:
 *   node --test tests/unit.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Load app.js into a sandboxed context with minimal browser globals ─────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const appCode   = readFileSync(join(__dirname, '../app.js'), 'utf8');

const sandbox = {
  // Browser globals required at module-evaluation time
  window: {
    location: { search: '' },
    matchMedia: () => ({ matches: false }),
  },
  document: {
    addEventListener:  () => {},
    getElementById:    () => null,
    querySelector:     () => null,
    querySelectorAll:  () => [],
    head:              { appendChild: () => {} },
    documentElement:   { dataset: {} },
    createElement:     () => ({ appendChild: () => {}, parentNode: null }),
  },
  localStorage: {
    getItem:    () => null,
    setItem:    () => {},
    removeItem: () => {},
  },
  // Forward standard Node globals
  URLSearchParams,
  setTimeout:         () => {},
  clearTimeout:       () => {},
  console,
  Date,
  Map,
  Set,
  Array,
  String,
  Number,
  Math,
  Boolean,
  Object,
  Promise,
  Error,
  isNaN,
  parseInt,
  encodeURIComponent,
};

createContext(sandbox);
runInContext(appCode, sandbox);

// Pull the functions we want to test out of the sandbox
const {
  escapeHtml,
  courtClass,
  setsToMatchScore,
  parseCourts,
  parseRounds,
  collectTeams,
  computeStandings,
  buildRankMap,
  renderMatchup,
} = sandbox;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal gviz table object used by parseRounds / setTitle. */
function makeTable(headers, rows) {
  return {
    cols: headers.map(label => ({ label })),
    rows: rows.map(cells => ({
      c: cells.map(cell =>
        cell == null
          ? null
          : typeof cell === 'object'
            ? cell           // allow { v, f } objects
            : { v: cell }
      ),
    })),
  };
}

/** Build a minimal round as returned by parseRounds. */
function makeRound(time, matchups) {
  return { time, matchups };
}

/** Build a matchup object. */
function makeMatchup(opts = {}) {
  return {
    court:     opts.court     ?? 'Court #1',
    idx:       opts.idx       ?? 0,
    hasScores: opts.hasScores ?? false,
    teamA:     opts.teamA     ?? '',
    teamB:     opts.teamB     ?? '',
    scoreA:    opts.scoreA    ?? '',
    scoreB:    opts.scoreB    ?? '',
  };
}

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    assert.equal(escapeHtml('a&b'), 'a&amp;b');
  });

  it('escapes less-than', () => {
    assert.equal(escapeHtml('<div>'), '&lt;div&gt;');
  });

  it('escapes greater-than', () => {
    assert.equal(escapeHtml('x>y'), 'x&gt;y');
  });

  it('escapes double-quote', () => {
    assert.equal(escapeHtml('"hello"'), '&quot;hello&quot;');
  });

  it('escapes multiple special chars in one string', () => {
    assert.equal(
      escapeHtml('<b class="x">a&b</b>'),
      '&lt;b class=&quot;x&quot;&gt;a&amp;b&lt;/b&gt;'
    );
  });

  it('returns plain strings unchanged', () => {
    assert.equal(escapeHtml('Hello World'), 'Hello World');
  });

  it('handles empty string', () => {
    assert.equal(escapeHtml(''), '');
  });
});

// ── courtClass ────────────────────────────────────────────────────────────────

describe('courtClass', () => {
  it('returns court-0 for index 0', () => {
    assert.equal(courtClass(0), 'court-0');
  });

  it('returns court-7 for index 7', () => {
    assert.equal(courtClass(7), 'court-7');
  });

  it('works for any positive integer', () => {
    assert.equal(courtClass(42), 'court-42');
  });
});

// ── setsToMatchScore ──────────────────────────────────────────────────────────

describe('setsToMatchScore', () => {
  it('counts A winning 2-1 across three sets', () => {
    // Set 1: 25-18 A wins, Set 2: 22-25 B wins, Set 3: 30-28 A wins
    const r = setsToMatchScore('25,22,30', '18,25,28');
    assert.equal(r.matchA, 2);
    assert.equal(r.matchB, 1);
    assert.equal(r.len,    3);
    // Spread into the current realm to satisfy deepStrictEqual across vm context boundary
    assert.deepEqual([...r.setsA], [25, 22, 30]);
    assert.deepEqual([...r.setsB], [18, 25, 28]);
  });

  it('counts A sweeping 2-0', () => {
    const r = setsToMatchScore('25,25', '18,20');
    assert.equal(r.matchA, 2);
    assert.equal(r.matchB, 0);
  });

  it('counts B winning 2-0', () => {
    const r = setsToMatchScore('18,20', '25,25');
    assert.equal(r.matchA, 0);
    assert.equal(r.matchB, 2);
  });

  it('handles a single set', () => {
    const r = setsToMatchScore('25', '20');
    assert.equal(r.matchA, 1);
    assert.equal(r.matchB, 0);
    assert.equal(r.len,    1);
  });

  it('tied sets give no wins to either side', () => {
    // Every set is a tie — should not increment either counter
    const r = setsToMatchScore('25,25', '25,25');
    assert.equal(r.matchA, 0);
    assert.equal(r.matchB, 0);
  });

  it('uses min length when arrays differ in length', () => {
    // A has 3 values, B has 2 — only 2 sets compared
    const r = setsToMatchScore('25,25,25', '18,18');
    assert.equal(r.len, 2);
    assert.equal(r.matchA, 2);
    assert.equal(r.matchB, 0);
  });

  it('trims whitespace around set scores', () => {
    const r = setsToMatchScore('25, 22', '18, 25');
    assert.equal(r.matchA, 1);
    assert.equal(r.matchB, 1);
  });
});

// ── parseCourts ───────────────────────────────────────────────────────────────

describe('parseCourts', () => {
  it('parses a single court with all four columns', () => {
    const headers = [
      'Options', 'Notes', 'Time',            // cols 0-2 skipped
      'Court #1 Team A', 'Court #1 Score A',
      'Court #1 Team B', 'Court #1 Score B',
    ];
    const courts = parseCourts(headers);
    assert.equal(courts.length, 1);
    const c = courts[0];
    assert.equal(c.name,      'Court #1');
    assert.equal(c.hasScores, true);
    assert.equal(c.teamACol,  3);
    assert.equal(c.scoreACol, 4);
    assert.equal(c.teamBCol,  5);
    assert.equal(c.scoreBCol, 6);
    assert.equal(c.idx,       0);
  });

  it('sets hasScores=false when score columns are absent', () => {
    const headers = [
      'Options', 'Notes', 'Time',
      'Court #1 Team A', 'Court #1 Team B',
    ];
    const courts = parseCourts(headers);
    assert.equal(courts[0].hasScores, false);
    assert.equal(courts[0].scoreACol, undefined);
    assert.equal(courts[0].scoreBCol, undefined);
  });

  it('sorts multiple courts alphabetically and assigns sequential idx', () => {
    const headers = [
      'Options', 'Notes', 'Time',
      'Court #3 Team A', 'Court #3 Team B',
      'Court #1 Team A', 'Court #1 Team B',
      'Court #2 Team A', 'Court #2 Team B',
    ];
    const courts = parseCourts(headers);
    assert.equal(courts.length, 3);
    assert.equal(courts[0].name, 'Court #1');
    assert.equal(courts[0].idx,  0);
    assert.equal(courts[1].name, 'Court #2');
    assert.equal(courts[1].idx,  1);
    assert.equal(courts[2].name, 'Court #3');
    assert.equal(courts[2].idx,  2);
  });

  it('ignores headers that do not match the court pattern', () => {
    const headers = ['Options', 'Notes', 'Time', 'Round', 'Notes', 'Court #1 Team A', 'Court #1 Team B'];
    const courts = parseCourts(headers);
    assert.equal(courts.length, 1);
  });

  it('skips columns at indices 0, 1, and 2 even if they match the pattern', () => {
    // Put a court-like header at index 2 — should be ignored
    const headers = ['Court #0 Team A', 'Court #0 Score A', 'Court #0 Team B', 'Court #1 Team A', 'Court #1 Team B'];
    const courts = parseCourts(headers);
    assert.equal(courts.length, 1);
    assert.equal(courts[0].name, 'Court #1');
  });

  it('is case-insensitive for field names (Team A, SCORE B, etc.)', () => {
    const headers = [
      'Options', 'Notes', 'Time',
      'Court #1 TEAM A', 'Court #1 SCORE A', 'Court #1 TEAM B', 'Court #1 SCORE B',
    ];
    const courts = parseCourts(headers);
    assert.equal(courts[0].hasScores, true);
    assert.equal(courts[0].teamACol,  3);
  });

  it('returns empty array when no court headers are present', () => {
    const courts = parseCourts(['Options', 'Notes', 'Time', 'Junk', 'More Junk']);
    assert.deepEqual(courts, []);
  });
});

// ── parseRounds ───────────────────────────────────────────────────────────────

describe('parseRounds', () => {
  const BASE_HEADERS = [
    'Options', 'Notes', 'Time',
    'Court #1 Team A', 'Court #1 Score A',
    'Court #1 Team B', 'Court #1 Score B',
  ];

  it('formats time array [9,0,0,0] as "9AM"', () => {
    const table = makeTable(BASE_HEADERS, [
      [null, null, { v: [9, 0, 0, 0] }, 'Eagles', '25', 'Falcons', '18'],
    ]);
    const rounds = parseRounds(table);
    assert.equal(rounds[0].time, '9AM');
  });

  it('formats time array [9,30,0,0] as "9:30AM"', () => {
    const table = makeTable(BASE_HEADERS, [
      [null, null, { v: [9, 30, 0, 0] }, 'Eagles', '25', 'Falcons', '18'],
    ]);
    const rounds = parseRounds(table);
    assert.equal(rounds[0].time, '9:30AM');
  });

  it('formats time array [13,0,0,0] as "1PM"', () => {
    const table = makeTable(BASE_HEADERS, [
      [null, null, { v: [13, 0, 0, 0] }, 'Eagles', '25', 'Falcons', '18'],
    ]);
    const rounds = parseRounds(table);
    assert.equal(rounds[0].time, '1PM');
  });

  it('formats time array [12,0,0,0] as "12PM"', () => {
    const table = makeTable(BASE_HEADERS, [
      [null, null, { v: [12, 0, 0, 0] }, 'Eagles', '25', 'Falcons', '18'],
    ]);
    const rounds = parseRounds(table);
    assert.equal(rounds[0].time, '12PM');
  });

  it('prefers pre-formatted .f string over .v array', () => {
    const table = makeTable(BASE_HEADERS, [
      [null, null, { v: [9, 0, 0, 0], f: '9:00 AM' }, 'Eagles', '25', 'Falcons', '18'],
    ]);
    const rounds = parseRounds(table);
    assert.equal(rounds[0].time, '9:00 AM');
  });

  it('produces one matchup per court per round', () => {
    const table = makeTable(BASE_HEADERS, [
      [null, null, { v: [9, 0, 0, 0] }, 'Eagles', '25', 'Falcons', '18'],
      [null, null, { v: [10, 0, 0, 0] }, 'Hawks', '22', 'Owls', '25'],
    ]);
    const rounds = parseRounds(table);
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0].matchups.length, 1);
    assert.equal(rounds[0].matchups[0].teamA,  'Eagles');
    assert.equal(rounds[0].matchups[0].scoreA, '25');
    assert.equal(rounds[1].matchups[0].teamB,  'Owls');
  });

  it('returns empty string for null cell values', () => {
    const table = makeTable(BASE_HEADERS, [
      [null, null, { v: [9, 0, 0, 0] }, null, null, null, null],
    ]);
    const rounds = parseRounds(table);
    const m = rounds[0].matchups[0];
    assert.equal(m.teamA,  '');
    assert.equal(m.scoreA, '');
    assert.equal(m.teamB,  '');
    assert.equal(m.scoreB, '');
  });

  it('sets scoreA/scoreB to empty string when court has no score columns', () => {
    const headers = ['Options', 'Notes', 'Time', 'Court #1 Team A', 'Court #1 Team B'];
    const table = makeTable(headers, [
      [null, null, { v: [9, 0, 0, 0] }, 'Eagles', 'Falcons'],
    ]);
    const rounds = parseRounds(table);
    assert.equal(rounds[0].matchups[0].scoreA, '');
    assert.equal(rounds[0].matchups[0].scoreB, '');
  });
});

// ── collectTeams ──────────────────────────────────────────────────────────────

describe('collectTeams', () => {
  it('returns sorted unique team names', () => {
    const rounds = [
      makeRound('9AM', [makeMatchup({ teamA: 'Zebras', teamB: 'Ants' })]),
      makeRound('10AM', [makeMatchup({ teamA: 'Bears', teamB: 'Zebras' })]),
    ];
    assert.deepEqual([...collectTeams(rounds)], ['Ants', 'Bears', 'Zebras']);
  });

  it('excludes empty team strings', () => {
    const rounds = [makeRound('9AM', [makeMatchup({ teamA: 'Eagles', teamB: '' })])];
    assert.deepEqual([...collectTeams(rounds)], ['Eagles']);
  });

  it('deduplicates teams appearing in multiple rounds', () => {
    const rounds = [
      makeRound('9AM',  [makeMatchup({ teamA: 'Alpha', teamB: 'Beta' })]),
      makeRound('10AM', [makeMatchup({ teamA: 'Alpha', teamB: 'Gamma' })]),
    ];
    const teams = [...collectTeams(rounds)];
    assert.equal(teams.filter(t => t === 'Alpha').length, 1);
    assert.deepEqual(teams, ['Alpha', 'Beta', 'Gamma']);
  });

  it('returns empty array when no rounds are present', () => {
    assert.deepEqual([...collectTeams([])], []);
  });

  it('handles multiple courts per round', () => {
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta' }),
      makeMatchup({ teamA: 'Gamma', teamB: 'Delta' }),
    ])];
    assert.deepEqual([...collectTeams(rounds)], ['Alpha', 'Beta', 'Delta', 'Gamma']);
  });
});

// ── computeStandings ──────────────────────────────────────────────────────────

describe('computeStandings', () => {
  it('returns empty stats and hasSets=false when there are no scored matches', () => {
    const rounds = [makeRound('9AM', [makeMatchup({ teamA: 'Alpha', teamB: 'Beta' })])];
    const { stats, hasSets } = computeStandings(rounds);
    assert.equal(hasSets, false);
    assert.equal(stats.size, 0);
  });

  it('skips rows missing teamA, teamB, or scores', () => {
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: '',      teamB: 'Beta',  scoreA: '25', scoreB: '18' }),
      makeMatchup({ teamA: 'Alpha', teamB: '',      scoreA: '25', scoreB: '18' }),
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta',  scoreA: '',   scoreB: ''   }),
    ])];
    const { stats } = computeStandings(rounds);
    assert.equal(stats.size, 0);
  });

  it('tracks win for simple numeric scores, hasSets stays false', () => {
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '25', scoreB: '18', hasScores: true }),
    ])];
    const { stats, hasSets } = computeStandings(rounds);
    assert.equal(hasSets, false);
    assert.equal(stats.get('Alpha').matchesWon, 1);
    assert.equal(stats.get('Beta').matchesWon,  0);
  });

  it('does not credit a win for tied simple scores', () => {
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '25', scoreB: '25', hasScores: true }),
    ])];
    const { stats } = computeStandings(rounds);
    assert.equal(stats.get('Alpha').matchesWon, 0);
    assert.equal(stats.get('Beta').matchesWon,  0);
  });

  it('sets hasSets=true and tracks set/point stats for comma-separated scores', () => {
    // Set 1: 25-18 A wins, Set 2: 22-25 B wins, Set 3: 30-28 A wins → Alpha wins 2-1
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '25,22,30', scoreB: '18,25,28', hasScores: true }),
    ])];
    const { stats, hasSets } = computeStandings(rounds);
    assert.equal(hasSets, true);

    const a = stats.get('Alpha');
    assert.equal(a.matchesWon,    1);
    assert.equal(a.setsWon,       2);
    assert.equal(a.setsLost,      1);
    assert.equal(a.pointsScored,  77);  // 25+22+30
    assert.equal(a.pointsAllowed, 71);  // 18+25+28

    const b = stats.get('Beta');
    assert.equal(b.matchesWon,    0);
    assert.equal(b.setsWon,       1);
    assert.equal(b.setsLost,      2);
    assert.equal(b.pointsScored,  71);
    assert.equal(b.pointsAllowed, 77);
  });

  it('in mixed mode, simple scores are treated as set counts', () => {
    // One set-based match (triggers hasSets=true), one simple match
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta',  scoreA: '25,22', scoreB: '18,25', hasScores: true }),
      makeMatchup({ teamA: 'Gamma', teamB: 'Delta', scoreA: '2',     scoreB: '1',     hasScores: true }),
    ])];
    const { stats, hasSets } = computeStandings(rounds);
    assert.equal(hasSets, true);
    // Gamma won the match (2 > 1) and their simple scores become setsWon/setsLost
    assert.equal(stats.get('Gamma').matchesWon, 1);
    assert.equal(stats.get('Gamma').setsWon,    2);
    assert.equal(stats.get('Gamma').setsLost,   1);
    assert.equal(stats.get('Delta').setsWon,    1);
    assert.equal(stats.get('Delta').setsLost,   2);
  });

  it('accumulates stats across multiple matches for the same team', () => {
    const rounds = [
      makeRound('9AM',  [makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '25', scoreB: '18', hasScores: true })]),
      makeRound('10AM', [makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '20', scoreB: '25', hasScores: true })]),
    ];
    const { stats } = computeStandings(rounds);
    assert.equal(stats.get('Alpha').matchesWon, 1);
    assert.equal(stats.get('Beta').matchesWon,  1);
  });
});

// ── buildRankMap ──────────────────────────────────────────────────────────────

describe('buildRankMap', () => {
  it('excludes teams with zero wins and zero points scored', () => {
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '0', scoreB: '0', hasScores: true }),
    ])];
    const standings = computeStandings(rounds);
    const rankMap = buildRankMap(rounds, standings);
    // Both teams tied at 0 wins, 0 points — not ranked
    assert.equal(rankMap.has('Alpha'), false);
    assert.equal(rankMap.has('Beta'),  false);
  });

  it('ranks team with a win above team without', () => {
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '25', scoreB: '18', hasScores: true }),
    ])];
    const standings = computeStandings(rounds);
    const rankMap = buildRankMap(rounds, standings);
    assert.equal(rankMap.get('Alpha'), 1);
    // Beta has 0 wins, 0 points → excluded
    assert.equal(rankMap.has('Beta'), false);
  });

  it('uses competition ranking (1,1,3) for ties', () => {
    const rounds = [
      makeRound('9AM', [
        makeMatchup({ teamA: 'A', teamB: 'X', scoreA: '25', scoreB: '18', hasScores: true }),
      ]),
      makeRound('10AM', [
        makeMatchup({ teamA: 'B', teamB: 'Y', scoreA: '25', scoreB: '18', hasScores: true }),
      ]),
      makeRound('11AM', [
        makeMatchup({ teamA: 'C', teamB: 'Z', scoreA: '25', scoreB: '18', hasScores: true }),
      ]),
    ];
    const standings = computeStandings(rounds);
    const rankMap = buildRankMap(rounds, standings);
    // A, B, C all have 1 win and 25 points scored (18 allowed) → all rank 1
    assert.equal(rankMap.get('A'), 1);
    assert.equal(rankMap.get('B'), 1);
    assert.equal(rankMap.get('C'), 1);
  });

  it('breaks ties by points scored when using set-based scoring', () => {
    // Both Alpha and Beta win 2-0. Alpha scores more points (47 vs 40),
    // so it should rank higher even though wins are equal.
    const rounds = [
      makeRound('9AM',  [makeMatchup({ teamA: 'Alpha', teamB: 'Loser1', scoreA: '25,22', scoreB: '18,20', hasScores: true })]),
      makeRound('10AM', [makeMatchup({ teamA: 'Beta',  teamB: 'Loser2', scoreA: '20,20', scoreB: '18,18', hasScores: true })]),
    ];
    const standings = computeStandings(rounds);
    // Alpha: 1 win, pointsScored=47; Beta: 1 win, pointsScored=40
    assert.equal(standings.hasSets, true);
    const rankMap = buildRankMap(rounds, standings);
    assert.equal(rankMap.get('Alpha'), 1);
    assert.equal(rankMap.get('Beta'),  2);
  });

  it('includes teams with pointsScored > 0 even with zero wins (set-based losers)', () => {
    const rounds = [makeRound('9AM', [
      makeMatchup({ teamA: 'Alpha', teamB: 'Beta', scoreA: '25,25', scoreB: '18,18', hasScores: true }),
    ])];
    const standings = computeStandings(rounds);
    const rankMap = buildRankMap(rounds, standings);
    // Beta lost but scored 18+18=36 points → should appear in rankMap
    assert.equal(rankMap.has('Beta'), true);
  });
});

// ── renderMatchup ─────────────────────────────────────────────────────────────

describe('renderMatchup', () => {
  it('returns a no-matches placeholder when both teams are empty', () => {
    const html = renderMatchup(makeMatchup({ teamA: '', teamB: '' }));
    assert.equal(html.trim(), '<span class="no-matches">—</span>');
  });

  it('renders both team names when teams are present without scores', () => {
    const html = renderMatchup(makeMatchup({ teamA: 'Eagles', teamB: 'Falcons' }));
    assert.ok(html.includes('Eagles'));
    assert.ok(html.includes('Falcons'));
  });

  it('applies winner class to team A when they have a higher numeric score', () => {
    const html = renderMatchup(makeMatchup({
      teamA: 'Eagles', teamB: 'Falcons', scoreA: '25', scoreB: '18',
    }));
    // Team A row should have winner class, team B should not
    const [teamASection, teamBSection] = html.split('vs-divider');
    assert.ok(teamASection.includes('winner'));
    assert.ok(!teamBSection.includes('winner'));
  });

  it('applies winner class to team B when they have a higher numeric score', () => {
    const html = renderMatchup(makeMatchup({
      teamA: 'Eagles', teamB: 'Falcons', scoreA: '18', scoreB: '25',
    }));
    const [teamASection, teamBSection] = html.split('vs-divider');
    assert.ok(!teamASection.includes('winner'));
    assert.ok(teamBSection.includes('winner'));
  });

  it('applies no winner class when scores are tied', () => {
    const html = renderMatchup(makeMatchup({
      teamA: 'Eagles', teamB: 'Falcons', scoreA: '25', scoreB: '25',
    }));
    assert.ok(!html.includes('winner'));
  });

  it('includes data-sets attribute for comma-separated scores', () => {
    const html = renderMatchup(makeMatchup({
      teamA: 'Eagles', teamB: 'Falcons',
      scoreA: '25,22,30', scoreB: '18,25,28',
    }));
    assert.ok(html.includes('data-sets'));
    assert.ok(html.includes('25,22,30|18,25,28'));
  });

  it('does not include data-sets for simple numeric scores', () => {
    const html = renderMatchup(makeMatchup({
      teamA: 'Eagles', teamB: 'Falcons', scoreA: '25', scoreB: '18',
    }));
    assert.ok(!html.includes('data-sets'));
  });

  it('shows match count (not raw scores) for set-based scoring', () => {
    // 25,22,30 vs 18,25,28 → A wins 2 sets, B wins 1 set
    const html = renderMatchup(makeMatchup({
      teamA: 'Eagles', teamB: 'Falcons',
      scoreA: '25,22,30', scoreB: '18,25,28',
    }));
    assert.ok(html.includes('team-score'));
    // The displayed scores should be 2 and 1, not the raw set scores
    // Find team-score spans
    const scores = [...html.matchAll(/<span class="team-score">(\d+)<\/span>/g)].map(m => m[1]);
    assert.deepEqual(scores, ['2', '1']);
  });

  it('shows rank badge for teams present in the rankMap', () => {
    const rankMap = new Map([['Eagles', 1], ['Falcons', 2]]);
    const html = renderMatchup(makeMatchup({ teamA: 'Eagles', teamB: 'Falcons' }), rankMap);
    assert.ok(html.includes('#1'));
    assert.ok(html.includes('#2'));
    assert.ok(html.includes('team-rank'));
  });

  it('shows no rank badge for teams absent from the rankMap', () => {
    const html = renderMatchup(makeMatchup({ teamA: 'Eagles', teamB: 'Falcons' }), new Map());
    assert.ok(!html.includes('team-rank'));
  });

  it('escapes special characters in team names inside the data-teams attribute', () => {
    // Team names in the display <span> are output raw; only the data-teams
    // attribute (used for the set-detail popup) goes through escapeHtml.
    const html = renderMatchup(makeMatchup({
      teamA: 'A&B Squad', teamB: '"Team" One',
      scoreA: '25,22', scoreB: '18,25',
    }));
    // data-teams attribute must be HTML-escaped
    assert.ok(html.includes('data-teams="A&amp;B Squad|&quot;Team&quot; One"'));
  });
});
