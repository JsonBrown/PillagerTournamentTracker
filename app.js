// ── Config ────────────────────────────────────────────────────────────────────
const SHEET_ID        = '152jcyxelkCBTir9-U_bcK7D8y1vIvqw1s_FzZ9pCDKY';
const REFRESH_MS      = 30_000;   // auto-refresh every 30 seconds
const FETCH_TIMEOUT   = 10_000;   // 10 second network timeout

// Read optional ?tab=<sheet name> from the page URL.
// Matches the gviz `sheet` parameter (tab name, case-sensitive).
// Omitting the parameter selects the first tab (default gviz behaviour).
const TAB_NAME = new URLSearchParams(window.location.search).get('tab') || null;
const TEAM_FILTER_KEY = 'teamFilter' + (TAB_NAME ? '_' + TAB_NAME : '');

let refreshTimer     = null;
let cachedRounds     = null;
let cachedStandings  = null;
let activeTeamFilter = '';

// ── Fetch via Google Visualization JSONP ──────────────────────────────────────
//
// The gviz/tq endpoint supports a JSONP-style call via the `responseHandler`
// option inside the `tqx` parameter.  This avoids any CORS issues with
// public sheets that are shared "anyone with the link can view".

function fetchSheetData() {
  return new Promise((resolve, reject) => {
    const cbName = '__gviz_' + Date.now();
    const script  = document.createElement('script');

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Request timed out'));
    }, FETCH_TIMEOUT);

    window[cbName] = function (response) {
      clearTimeout(timer);
      cleanup();
      if (response && response.status === 'ok') {
        resolve(response.table);
      } else {
        const detail = response?.errors?.[0]?.detailed_message
                    || response?.errors?.[0]?.message
                    || 'Unknown error from Google Sheets';
        reject(new Error(detail));
      }
    };

    function cleanup() {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    script.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('Network error')); };
    const tabParam = TAB_NAME ? `&sheet=${encodeURIComponent(TAB_NAME)}` : '';
    script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
               + `?tqx=out:json;responseHandler:${cbName}${tabParam}`
               + `&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

// ── Parse column headers → court definitions ──────────────────────────────────
//
// Expects column headers of the form:
//   "{court name} Team A" / "{court name} Team B"
//   "{court name} Score A" / "{court name} Score B"

function parseCourts(headers) {
  const map = {};

  headers.forEach((label, i) => {
    if (i < 3 || !label) return;                     // skip col A (options), col B (ignored), col C (time of day)
    const m = label.match(/^(.*Court\s+#?\d+)\s+(.+)$/i);
    if (!m) return;

    const courtName = m[1];
    const field     = m[2].trim().toLowerCase();

    if (!map[courtName]) map[courtName] = { name: courtName, hasScores: false };
    const c = map[courtName];

    if      (field === 'team a')  c.teamACol  = i;
    else if (field === 'team b')  c.teamBCol  = i;
    else if (field === 'score a') { c.scoreACol = i; c.hasScores = true; }
    else if (field === 'score b') { c.scoreBCol = i; c.hasScores = true; }
  });

  // Sort alphabetically and tag each court with its sorted index
  const sorted = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((c, i) => ({ ...c, idx: i }));
}

// ── Turn a gviz table into plain round objects ────────────────────────────────

function parseRounds(table) {
  const headers      = table.cols.map(c => c.label ?? '');
  const courts       = parseCourts(headers);
  const namedMatches = parseNamedMatches(table);

  const cell = (row, idx) => {
    if (idx == null) return '';
    const v = row.c?.[idx]?.v;
    return v != null ? String(v).trim() : '';
  };

  // gviz returns time-of-day columns as [hours, minutes, seconds, ms].
  // Prefer the sheet's pre-formatted string (.f) when present; otherwise
  // build "9AM" / "9:30AM" from the array.
  const timeCell = (row, idx) => {
    const col = row.c?.[idx];
    if (!col) return '';
    if (col.f != null) return String(col.f).trim();
    const v = col.v;
    if (v == null) return '';
    if (Array.isArray(v)) {
      const [h, m] = v;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12  = h % 12 || 12;
      return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
    }
    return String(v).trim();
  };

  return table.rows.map((row, rowIdx) => ({
    time:     timeCell(row, 2),
    matchups: courts.map(ct => ({
      court:     ct.name,
      idx:       ct.idx,
      hasScores: ct.hasScores,
      teamA:     cell(row, ct.teamACol),
      teamB:     cell(row, ct.teamBCol),
      scoreA:    ct.scoreACol != null ? cell(row, ct.scoreACol) : '',
      scoreB:    ct.scoreBCol != null ? cell(row, ct.scoreBCol) : '',
      matchName: namedMatches.get(`${rowIdx}-${ct.teamACol}`) ?? null,
    })),
  }));
}

// ── Team filter ───────────────────────────────────────────────────────────────

function collectTeams(rounds) {
  const teams = new Set();
  for (const round of rounds) {
    for (const m of round.matchups) {
      if (m.teamA) teams.add(m.teamA);
      if (m.teamB) teams.add(m.teamB);
    }
  }
  return [...teams].sort((a, b) => a.localeCompare(b));
}

// ── Tournament standings ───────────────────────────────────────────────────────

function computeStandings(rounds) {
  const stats = new Map();
  let hasPoolMatches = false;

  const ensureTeam = name => {
    if (!stats.has(name)) {
      stats.set(name, { matchesWon: 0, gamesWon: 0, gamesLost: 0, pointsScored: 0, pointsAllowed: 0 });
    }
    return stats.get(name);
  };

  for (const round of rounds) {
    for (const m of round.matchups) {
      if (!m.teamA || !m.teamB) continue;
      if (m.scoreA === '' || m.scoreB === '') continue;

      if (String(m.scoreA).includes(',') || String(m.scoreB).includes(',')) {
        hasPoolMatches = true;
        const { matchA, matchB, gamesA, gamesB, len } = parsePoolMatchScore(m.scoreA, m.scoreB);
        const tA = ensureTeam(m.teamA);
        const tB = ensureTeam(m.teamB);
        if (matchA > matchB) tA.matchesWon++;
        else if (matchB > matchA) tB.matchesWon++;
        for (let i = 0; i < len; i++) {
          tA.gamesWon      += gamesA[i] > gamesB[i] ? 1 : 0;
          tA.gamesLost     += gamesB[i] > gamesA[i] ? 1 : 0;
          tA.pointsScored  += gamesA[i];
          tA.pointsAllowed += gamesB[i];
          tB.gamesWon      += gamesB[i] > gamesA[i] ? 1 : 0;
          tB.gamesLost     += gamesA[i] > gamesB[i] ? 1 : 0;
          tB.pointsScored  += gamesB[i];
          tB.pointsAllowed += gamesA[i];
        }
      } else {
        continue; // non-pool matches are excluded from rankings
      }
    }
  }

  return { stats, hasPoolMatches };
}


function populateTeamFilter(teams) {
  const sel = document.getElementById('team-filter');
  const prev = localStorage.getItem(TEAM_FILTER_KEY) || sel.value;
  sel.innerHTML = '<option value="">All Teams</option>'
    + teams.map(t => `<option value="${t}"${t === prev ? ' selected' : ''}>${escapeHtml(stripPoolSuffix(t))}</option>`).join('');
  activeTeamFilter = sel.value;
  sel.disabled = teams.length === 0;
}

function filterByTeam(team) {
  activeTeamFilter = team;
  if (team) {
    localStorage.setItem(TEAM_FILTER_KEY, team);
  } else {
    localStorage.removeItem(TEAM_FILTER_KEY);
  }
  if (cachedRounds) {
    renderAll(cachedRounds);
    if (cachedStandings) renderStandings(cachedRounds, cachedStandings);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractPool(teamName) {
  const m = teamName.match(/\(P(\d+)\)\s*$/i);
  return m ? `P${m[1]}` : null;
}

function stripPoolSuffix(teamName) {
  return teamName.replace(/\s*\(P\d+\)\s*$/i, '').trim();
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function courtClass(idx) {
  return `court-${idx}`;
}

function parsePoolMatchScore(scoreA, scoreB) {
  const gamesA = String(scoreA).split(',').map(s => Number(s.trim()));
  const gamesB = String(scoreB).split(',').map(s => Number(s.trim()));
  const len = Math.min(gamesA.length, gamesB.length);
  let matchA = 0, matchB = 0;
  for (let i = 0; i < len; i++) {
    if (gamesA[i] > gamesB[i]) matchA++;
    else if (gamesB[i] > gamesA[i]) matchB++;
  }
  return { matchA, matchB, gamesA, gamesB, len };
}

function renderMatchup(m) {
  if (!m.teamA && !m.teamB && !m.matchName) return '<span class="no-matches">—</span>';

  let displayA = m.scoreA, displayB = m.scoreB;
  let sA = m.scoreA !== '' ? Number(m.scoreA) : null;
  let sB = m.scoreB !== '' ? Number(m.scoreB) : null;
  let poolMatchData = null;

  if (String(m.scoreA).includes(',') || String(m.scoreB).includes(',')) {
    const result = parsePoolMatchScore(m.scoreA, m.scoreB);
    displayA = result.matchA;
    displayB = result.matchB;
    sA = result.matchA;
    sB = result.matchB;
    poolMatchData = result;
  }

  const both  = sA != null && sB != null;
  const aWins = both && sA > sB;
  const bWins = both && sB > sA;

  const scoreTag = (s) =>
    s != null && s !== '' ? `<span class="team-score">${s}</span>` : '';

  const poolMatchAttr = poolMatchData
    ? ` data-games="${m.scoreA}|${m.scoreB}" data-teams="${escapeHtml(m.teamA)}|${escapeHtml(m.teamB)}" style="cursor:pointer"`
    : '';

  const nameBadge = m.matchName
    ? `<div class="match-name">${escapeHtml(m.matchName)}</div>`
    : '';

  return `<div class="match-teams"${poolMatchAttr}>
  ${nameBadge}<div class="team-row${aWins ? ' winner' : ''}">
    <span class="team-players">${m.teamA ? stripPoolSuffix(m.teamA) : '—'}</span>${scoreTag(displayA)}
  </div>
  <div class="vs-divider">vs</div>
  <div class="team-row${bWins ? ' winner' : ''}">
    <span class="team-players">${m.teamB ? stripPoolSuffix(m.teamB) : '—'}</span>${scoreTag(displayB)}
  </div>
</div>`;
}

function renderAll(rounds) {
  const prevWrapper = document.querySelector('.schedule-wrapper');
  const sx = prevWrapper ? prevWrapper.scrollLeft : 0;
  const sy = prevWrapper ? prevWrapper.scrollTop : 0;

  const validRounds = rounds.filter(r => r.time);
  if (validRounds.length === 0) {
    document.getElementById('tournament-content').innerHTML =
      '<p class="loading">Sheet is empty — add data to your Google Sheet to see matches here.</p>';
    return;
  }

  // Columns = time slots; rows = courts (transposed view)
  const allCourts = validRounds[0].matchups;

  // When a team filter is active, only show courts that have that team in at least one time slot
  let courtIndices = allCourts.map((_, i) => i);
  if (activeTeamFilter) {
    courtIndices = courtIndices.filter(i =>
      validRounds.some(r => {
        const m = r.matchups[i];
        return m.teamA === activeTeamFilter || m.teamB === activeTeamFilter;
      })
    );
    if (courtIndices.length === 0) {
      document.getElementById('tournament-content').innerHTML =
        '<p class="loading">No matches found for the selected team.</p>';
      return;
    }
  }

  const headerCells = validRounds
    .map(r => `<th class="time-header">${r.time}</th>`)
    .join('');

  const bodyRows = courtIndices.map(courtIdx => {
    const courtName = allCourts[courtIdx].court;
    const cells = validRounds.map(round => {
      const m = round.matchups[courtIdx];
      const show = !activeTeamFilter
        || m.teamA === activeTeamFilter
        || m.teamB === activeTeamFilter;
      return `<td class="matchup-cell">${show ? renderMatchup(m) : '<span class="no-matches">—</span>'}</td>`;
    }).join('');
    return `<tr><th class="court-header ${courtClass(allCourts[courtIdx].idx)}">${courtName}</th>${cells}</tr>`;
  }).join('');

  document.getElementById('tournament-content').innerHTML =
    `<div class="schedule-wrapper"><table class="schedule-table"><thead><tr><th class="corner-cell"></th>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  const newWrapper = document.querySelector('.schedule-wrapper');
  if (newWrapper) { newWrapper.scrollLeft = sx; newWrapper.scrollTop = sy; }
}

// ── Team Stats tab ────────────────────────────────────────────────────────────

let activeTab = 'schedule';

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('tab-active', btn.dataset.tab === tab);
  });
  document.getElementById('tournament-content').hidden = tab !== 'schedule';
  document.getElementById('standings-content').hidden  = tab !== 'standings';
}

function renderNamedMatchesSection(rounds) {
  const matches = [];
  for (const round of rounds) {
    for (const m of round.matchups) {
      if (m.matchName) matches.push(m);
    }
  }
  if (matches.length === 0) return '';

  const cards = matches.map(m => {
    const sA = m.scoreA !== '' ? Number(m.scoreA) : null;
    const sB = m.scoreB !== '' ? Number(m.scoreB) : null;
    const both = sA != null && sB != null;
    const aWins = both && sA > sB;
    const bWins = both && sB > sA;

    const teamAName = m.teamA ? stripPoolSuffix(m.teamA) : 'TBD';
    const teamBName = m.teamB ? stripPoolSuffix(m.teamB) : 'TBD';

    const scoreA = sA != null ? `<span class="named-match-score">${sA}</span>` : '';
    const scoreB = sB != null ? `<span class="named-match-score">${sB}</span>` : '';

    const hlA = activeTeamFilter && m.teamA === activeTeamFilter ? ' team-filter-highlight' : '';
    const hlB = activeTeamFilter && m.teamB === activeTeamFilter ? ' team-filter-highlight' : '';

    return `<div class="named-match-card">
      <div class="named-match-label">${escapeHtml(m.matchName)}</div>
      <div class="named-match-teams">
        <div class="named-match-team${aWins ? ' winner' : ''}${hlA}">
          <span class="named-match-team-name${m.teamA ? '' : ' tbd'}">${escapeHtml(teamAName)}</span>${scoreA}
        </div>
        <div class="named-match-vs">vs</div>
        <div class="named-match-team${bWins ? ' winner' : ''}${hlB}">
          <span class="named-match-team-name${m.teamB ? '' : ' tbd'}">${escapeHtml(teamBName)}</span>${scoreB}
        </div>
      </div>
    </div>`;
  }).join('');

  return `<h3 class="pool-section-header named-matches-header">Bracket Matches</h3>
<div class="named-matches-list">${cards}</div>`;
}

function renderStandings(rounds, { stats, hasPoolMatches }) {
  const el = document.getElementById('standings-content');
  const allTeams = collectTeams(rounds);

  if (allTeams.length === 0) {
    el.innerHTML = '<p class="loading">No teams found.</p>';
    return;
  }

  const hasPoints = [...stats.values()].some(s => s.pointsScored > 0);

  const rows = allTeams.map(name => {
    const s = stats.get(name) ?? { matchesWon: 0, gamesWon: 0, gamesLost: 0, pointsScored: 0, pointsAllowed: 0 };
    return { name, pool: extractPool(name), wins: s.matchesWon, gamesWon: s.gamesWon, gamesLost: s.gamesLost,
             pointsScored: s.pointsScored, pointsAllowed: s.pointsAllowed,
             pointDiff: s.pointsScored - s.pointsAllowed };
  });

  // Group by pool; null key = default pool
  const poolMap = new Map();
  for (const r of rows) {
    const key = r.pool ?? null;
    if (!poolMap.has(key)) poolMap.set(key, []);
    poolMap.get(key).push(r);
  }

  // Named pools sorted numerically, default pool last
  const poolKeys = [...poolMap.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return parseInt(a.slice(1)) - parseInt(b.slice(1));
  });

  const multiPool = poolKeys.length > 1;

  const fmt = n => n > 0 ? `+${n}` : `${n}`;
  const pdClass = n => n > 0 ? 'pd-pos' : n < 0 ? 'pd-neg' : '';

  const extraHead = hasPoolMatches
    ? '<th title="Games Won">GW</th><th title="Games Lost">GL</th><th title="Points Scored">PS</th><th title="Points Allowed">PA</th><th title="Point Differential">PD</th>'
    : hasPoints
      ? '<th title="Points Scored">PS</th><th title="Points Allowed">PA</th><th title="Point Differential">PD</th>'
      : '';

  const renderPoolTable = (poolRows) => {
    // Rank: games won desc → games lost asc → point differential desc → name asc
    poolRows.sort((a, b) =>
      b.gamesWon - a.gamesWon ||
      a.gamesLost - b.gamesLost ||
      b.pointDiff - a.pointDiff ||
      a.name.localeCompare(b.name)
    );
    // Standard competition ranking (1,1,3…)
    let rankCounter = 1;
    poolRows.forEach((r, i) => {
      r.rank = i > 0 && r.gamesWon === poolRows[i - 1].gamesWon &&
               r.gamesLost === poolRows[i - 1].gamesLost &&
               r.pointDiff === poolRows[i - 1].pointDiff
        ? poolRows[i - 1].rank
        : rankCounter;
      rankCounter++;
    });
    const tableRows = poolRows.map(r => {
      const extraData = hasPoolMatches
        ? `<td>${r.gamesWon}</td><td>${r.gamesLost}</td><td>${r.pointsScored}</td><td>${r.pointsAllowed}</td><td class="${pdClass(r.pointDiff)}">${fmt(r.pointDiff)}</td>`
        : hasPoints
          ? `<td>${r.pointsScored}</td><td>${r.pointsAllowed}</td><td class="${pdClass(r.pointDiff)}">${fmt(r.pointDiff)}</td>`
          : '';
      const rankMedal = r.rank === 1 ? ' rank-gold' : r.rank === 2 ? ' rank-silver' : r.rank === 3 ? ' rank-bronze' : '';
      const filterHighlight = activeTeamFilter && r.name === activeTeamFilter ? ' team-filter-highlight' : '';
      return `<tr class="${rankMedal}${filterHighlight}"><td class="rank-cell">${r.rank}</td><td class="team-name-cell">${escapeHtml(stripPoolSuffix(r.name))}</td><td class="wins-cell">${r.wins}</td>${extraData}</tr>`;
    }).join('');
    return `<div class="standings-wrapper">
      <table class="standings-table">
        <thead><tr><th>#</th><th>Team</th><th title="Wins">W</th>${extraHead}</tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
  };

  const sections = poolKeys.map(key => {
    const header = multiPool
      ? `<h3 class="pool-section-header">${key ? `Pool ${key.slice(1)}` : 'Open Pool'}</h3>`
      : '';
    return header + renderPoolTable(poolMap.get(key));
  }).join('');

  const legendItems = [
    '<span><strong>#</strong> Rank</span>',
    '<span><strong>W</strong> Wins</span>',
    ...(hasPoolMatches ? ['<span><strong>GW</strong> Games Won</span>', '<span><strong>GL</strong> Games Lost</span>'] : []),
    ...((hasPoolMatches || hasPoints) ? ['<span><strong>PS</strong> Points Scored</span>', '<span><strong>PA</strong> Points Allowed</span>', '<span><strong>PD</strong> Point Differential</span>'] : []),
  ].join('');

  const namedMatchesHtml = renderNamedMatchesSection(rounds);
  el.innerHTML = `${sections}<div class="standings-legend">${legendItems}</div>${namedMatchesHtml}`;
}

// ── Sheet options (Column A) ──────────────────────────────────────────────────
// A1 = tournament name, A2 = logo URL, A3 = hide rankings tab (boolean)

function applySheetOptions(table) {
  const col = (row) => table.rows?.[row]?.c?.[0]?.v;

  const name = col(0);
  if (name) {
    const title = String(name).trim();
    document.querySelector('h1').textContent = title;
    document.title = title;
  }

  const logoUrl = col(1);
  const img = document.getElementById('site-logo');
  if (logoUrl && img) {
    img.src = String(logoUrl).trim();
    img.hidden = false;
  }

  const hideRankings = col(2) === 'TRUE';
  const btn = document.querySelector('.tab-btn[data-tab="standings"]');
  if (btn) {
    btn.hidden = hideRankings;
    if (hideRankings && activeTab === 'standings') showTab('schedule');
  }
}

// ── Named matches (Column A, rows 10–29) ─────────────────────────────────────
//
// Each cell may contain "{match name} ({cell ref})" e.g. "Silver Semifinal (D5)".
// The cell ref points to the "Team A" cell of the target matchup (1-based, A1 notation).
// Returns a Map keyed by "rowIdx-colIdx" (both 0-based) → label string.

function parseNamedMatches(table) {
  const named = new Map();
  for (let r = 8; r <= 27; r++) {      // A10 … A29 (20 named match slots)
    const val = table.rows?.[r]?.c?.[0]?.v;
    if (!val) continue;
    const m = String(val).trim().match(/^(.+)\s+\(([A-Z]+)(\d+)\)\s*$/i);
    if (!m) continue;
    const matchName = m[1].trim();
    const colStr    = m[2].toUpperCase();
    const rowNum    = parseInt(m[3], 10);

    // Convert spreadsheet column letter(s) to 0-based index (A→0, B→1, D→3 …)
    let colIdx = 0;
    for (const ch of colStr) colIdx = colIdx * 26 + (ch.charCodeAt(0) - 64);
    colIdx -= 1;

    named.set(`${rowNum - 2}-${colIdx}`, matchName);
  }
  return named;
}

// ── Status helpers ────────────────────────────────────────────────────────────

function setStatus(text, state /* 'live' | 'loading' | 'error' | 'idle' */) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  dot.className = `dot dot-${state}`;
}

// ── Load cycle ────────────────────────────────────────────────────────────────

async function loadData() {
  setStatus('Loading…', 'loading');
  try {
    const table  = await fetchSheetData();
    applySheetOptions(table);
    const rounds = parseRounds(table);
    cachedRounds = rounds;
    cachedStandings = computeStandings(rounds);
    populateTeamFilter(collectTeams(rounds));
    renderAll(rounds);
    renderStandings(rounds, cachedStandings);
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setStatus(`Updated ${t} · refreshes every 30 s`, 'live');
  } catch (err) {
    console.error('[Tournament Tracker]', err);
    setStatus('Failed to load — retrying in 30 s', 'error');
    document.getElementById('tournament-content').innerHTML =
      `<p class="error-msg">Could not load sheet data: ${err.message}</p>`;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadData();
    scheduleRefresh();
  }, REFRESH_MS);
}

function manualRefresh() {
  clearTimeout(refreshTimer);
  loadData().then(scheduleRefresh);
}

// ── Theme toggle ──────────────────────────────────────────────────────────────

function effectiveTheme() {
  const stored = localStorage.getItem('theme');
  if (stored) return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'light' ? '☾' : '☀';
}

function toggleTheme() {
  const next = effectiveTheme() === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(effectiveTheme());
  loadData().then(scheduleRefresh);

  // Pool match detail popup — event delegation on the content area
  document.getElementById('tournament-content').addEventListener('click', e => {
    const card = e.target.closest('[data-games]');
    if (!card) return;
    const [rawA, rawB] = card.dataset.games.split('|');
    const [teamAName, teamBName] = (card.dataset.teams || '|').split('|');
    const { matchA, matchB, gamesA, gamesB, len } = parsePoolMatchScore(rawA, rawB);
    const rows = Array.from({ length: len }, (_, i) =>
      `<div class="game-row">
        <span class="game-label">Game ${i + 1}</span>
        <span class="${gamesA[i] > gamesB[i] ? 'winner' : ''}">${gamesA[i]}</span>
        <span class="game-dash">–</span>
        <span class="${gamesB[i] > gamesA[i] ? 'winner' : ''}">${gamesB[i]}</span>
      </div>`
    ).join('');

    let h2hPD = 0;
    for (let i = 0; i < len; i++) h2hPD += gamesA[i] - gamesB[i];
    const fmtPD = n => n > 0 ? `+${n}` : `${n}`;
    const pdCls = n => n > 0 ? 'pd-pos' : n < 0 ? 'pd-neg' : '';
    const pdRow = `<div class="game-row h2h-pd-row">
      <span class="game-label">PD</span>
      <span class="${pdCls(h2hPD)}">${fmtPD(h2hPD)}</span>
      <span class="game-dash">–</span>
      <span class="${pdCls(-h2hPD)}">${fmtPD(-h2hPD)}</span>
    </div>`;

    let statsHtml = '';
    if (cachedStandings && teamAName && teamBName) {
      const { stats, hasPoolMatches } = cachedStandings;
      const sA = stats.get(teamAName) ?? { matchesWon: 0, gamesWon: 0, gamesLost: 0, pointsScored: 0, pointsAllowed: 0 };
      const sB = stats.get(teamBName) ?? { matchesWon: 0, gamesWon: 0, gamesLost: 0, pointsScored: 0, pointsAllowed: 0 };
      const pdA = sA.pointsScored - sA.pointsAllowed;
      const pdB = sB.pointsScored - sB.pointsAllowed;
      const fmt = n => n > 0 ? `+${n}` : `${n}`;
      const pdClass = n => n > 0 ? 'pd-pos' : n < 0 ? 'pd-neg' : '';
      // Compute this match's contribution per team
      let mGamesWonA = 0, mGamesLostA = 0, mPSA = 0, mPAA = 0;
      let mGamesWonB = 0, mGamesLostB = 0, mPSB = 0, mPAB = 0;
      for (let i = 0; i < len; i++) {
        if (gamesA[i] > gamesB[i]) { mGamesWonA++; mGamesLostB++; }
        else if (gamesB[i] > gamesA[i]) { mGamesWonB++; mGamesLostA++; }
        mPSA += gamesA[i]; mPAA += gamesB[i];
        mPSB += gamesB[i]; mPAB += gamesA[i];
      }
      const mWinA = matchA > matchB ? 1 : 0;
      const mWinB = matchB > matchA ? 1 : 0;
      const mPDA = mPSA - mPAA;
      const mPDB = mPSB - mPAB;

      // statDefs: [label, totalA, totalB, isPd, matchDeltaA, matchDeltaB]
      const statDefs = [
        ['Wins',              sA.matchesWon,    sB.matchesWon,    false, mWinA,       mWinB],
        ...(hasPoolMatches ? [
          ['Games Won',       sA.gamesWon,      sB.gamesWon,      false, mGamesWonA,  mGamesWonB],
          ['Games Lost',      sA.gamesLost,     sB.gamesLost,     false, mGamesLostA, mGamesLostB],
          ['Points Scored',   sA.pointsScored,  sB.pointsScored,  false, mPSA,        mPSB],
          ['Points Allowed',  sA.pointsAllowed, sB.pointsAllowed, false, mPAA,        mPAB],
          ['Point Differential', pdA,           pdB,              true,  mPDA,        mPDB],
        ] : []),
      ];
      const teamList = (name, vals) =>
        `<div class="stats-team-block">
          <div class="stats-team-heading">${escapeHtml(stripPoolSuffix(name))}</div>
          <ul class="stats-list">
            ${vals.map(([label, v, , isPd, delta]) => {
              const deltaHtml = delta != null
                ? ` <span class="stat-delta">(${isPd ? fmt(delta) : delta})</span>`
                : '';
              return `<li><span class="stat-label">${label}:</span> <span class="${isPd ? pdClass(v) : ''}">${isPd ? fmt(v) : v}</span>${deltaHtml}</li>`;
            }).join('')}
          </ul>
        </div>`;
      statsHtml = `<div class="stats-section">
        ${teamList(teamAName, statDefs)}
        ${teamList(teamBName, statDefs.map(([l, , vB, isPd, , dB]) => [l, vB, null, isPd, dB]))}
      </div>`;
    }

    const popup = document.getElementById('pool-popup');
    popup.querySelector('.pool-popup-body').innerHTML = rows + pdRow; // + statsHtml;
    const cell = card.closest('td') || card;
    const rect = cell.getBoundingClientRect();
    popup.style.top      = `${rect.bottom + window.scrollY + 6}px`;
    popup.style.left     = `${rect.left  + window.scrollX}px`;
    popup.style.minWidth = `${rect.width}px`;
    popup.classList.remove('hidden');
  });

  document.getElementById('pool-popup-close').addEventListener('click', () => {
    document.getElementById('pool-popup').classList.add('hidden');
  });

  document.addEventListener('click', e => {
    const popup = document.getElementById('pool-popup');
    if (!popup.classList.contains('hidden') &&
        !popup.contains(e.target) &&
        !e.target.closest('[data-games]')) {
      popup.classList.add('hidden');
    }
  });
});
