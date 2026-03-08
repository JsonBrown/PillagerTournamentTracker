// ── Config ────────────────────────────────────────────────────────────────────
const SHEET_ID        = '152jcyxelkCBTir9-U_bcK7D8y1vIvqw1s_FzZ9pCDKY';
const REFRESH_MS      = 30_000;   // auto-refresh every 30 seconds
const FETCH_TIMEOUT   = 10_000;   // 10 second network timeout

// Read optional ?tab=<sheet name> from the page URL.
// Matches the gviz `sheet` parameter (tab name, case-sensitive).
// Omitting the parameter selects the first tab (default gviz behaviour).
const TAB_NAME = new URLSearchParams(window.location.search).get('tab') || null;
const TEAM_FILTER_KEY = 'teamFilter' + (TAB_NAME ? '_' + TAB_NAME : '');

let refreshTimer    = null;
let cachedRounds    = null;
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
               + `?tqx=out:json;responseHandler:${cbName}${tabParam}`;
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
  const headers = table.cols.map(c => c.label ?? '');
  const courts  = parseCourts(headers);

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

  return table.rows.map(row => ({
    time:     timeCell(row, 2),
    matchups: courts.map(ct => ({
      court:     ct.name,
      idx:       ct.idx,
      hasScores: ct.hasScores,
      teamA:     cell(row, ct.teamACol),
      teamB:     cell(row, ct.teamBCol),
      scoreA:    ct.scoreACol != null ? cell(row, ct.scoreACol) : '',
      scoreB:    ct.scoreBCol != null ? cell(row, ct.scoreBCol) : '',
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

function populateTeamFilter(teams) {
  const sel = document.getElementById('team-filter');
  const prev = localStorage.getItem(TEAM_FILTER_KEY) || sel.value;
  sel.innerHTML = '<option value="">All Teams</option>'
    + teams.map(t => `<option value="${t}"${t === prev ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
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
  if (cachedRounds) renderAll(cachedRounds);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function courtClass(idx) {
  return `court-${idx}`;
}

function setsToMatchScore(scoreA, scoreB) {
  const setsA = String(scoreA).split(',').map(s => Number(s.trim()));
  const setsB = String(scoreB).split(',').map(s => Number(s.trim()));
  const len = Math.min(setsA.length, setsB.length);
  let matchA = 0, matchB = 0;
  for (let i = 0; i < len; i++) {
    if (setsA[i] > setsB[i]) matchA++;
    else if (setsB[i] > setsA[i]) matchB++;
  }
  return { matchA, matchB, setsA, setsB, len };
}

function renderMatchup(m) {
  if (!m.teamA && !m.teamB) return '<span class="no-matches">—</span>';

  let displayA = m.scoreA, displayB = m.scoreB;
  let sA = m.scoreA !== '' ? Number(m.scoreA) : null;
  let sB = m.scoreB !== '' ? Number(m.scoreB) : null;
  let setData = null;

  if (String(m.scoreA).includes(',') || String(m.scoreB).includes(',')) {
    const result = setsToMatchScore(m.scoreA, m.scoreB);
    displayA = result.matchA;
    displayB = result.matchB;
    sA = result.matchA;
    sB = result.matchB;
    setData = result;
  }

  const both  = sA != null && sB != null;
  const aWins = both && sA > sB;
  const bWins = both && sB > sA;

  const scoreTag = (s) =>
    s != null && s !== '' ? `<span class="team-score">${s}</span>` : '';

  const setsAttr = setData
    ? ` data-sets="${m.scoreA}|${m.scoreB}" style="cursor:pointer"`
    : '';

  return `<div class="match-teams"${setsAttr}>
  <div class="team-row${aWins ? ' winner' : ''}">
    <span class="team-players">${m.teamA || '—'}</span>${scoreTag(displayA)}
  </div>
  <div class="vs-divider">vs</div>
  <div class="team-row${bWins ? ' winner' : ''}">
    <span class="team-players">${m.teamB || '—'}</span>${scoreTag(displayB)}
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

// ── Title ─────────────────────────────────────────────────────────────────────

function setTitle(table) {
  const name = table.rows?.[0]?.c?.[0]?.v;
  if (name) {
    const title = String(name).trim();
    document.querySelector('h1').textContent = title;
    document.title = title;
  }

  const logoUrl = table.rows?.[1]?.c?.[0]?.v;
  const img = document.getElementById('site-logo');
  if (logoUrl && img) {
    img.src = String(logoUrl).trim();
    img.hidden = false;
  }
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
    setTitle(table);
    const rounds = parseRounds(table);
    cachedRounds = rounds;
    populateTeamFilter(collectTeams(rounds));
    renderAll(rounds);
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

  // Set detail popup — event delegation on the content area
  document.getElementById('tournament-content').addEventListener('click', e => {
    const card = e.target.closest('[data-sets]');
    if (!card) return;
    const [rawA, rawB] = card.dataset.sets.split('|');
    const { setsA, setsB, len } = setsToMatchScore(rawA, rawB);
    const rows = Array.from({ length: len }, (_, i) =>
      `<div class="set-row">
        <span class="set-label">Set ${i + 1}</span>
        <span class="${setsA[i] > setsB[i] ? 'winner' : ''}">${setsA[i]}</span>
        <span class="set-dash">–</span>
        <span class="${setsB[i] > setsA[i] ? 'winner' : ''}">${setsB[i]}</span>
      </div>`
    ).join('');
    const popup = document.getElementById('sets-popup');
    popup.querySelector('.sets-popup-body').innerHTML = rows;
    const rect = card.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + window.scrollY + 6}px`;
    popup.style.left = `${rect.left  + window.scrollX}px`;
    popup.classList.remove('hidden');
  });

  document.getElementById('sets-popup-close').addEventListener('click', () => {
    document.getElementById('sets-popup').classList.add('hidden');
  });

  document.addEventListener('click', e => {
    const popup = document.getElementById('sets-popup');
    if (!popup.classList.contains('hidden') &&
        !popup.contains(e.target) &&
        !e.target.closest('[data-sets]')) {
      popup.classList.add('hidden');
    }
  });
});
