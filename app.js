const API_BASE = 'https://worldcup26.ir/get';
const GROUP_ORDER = 'ABCDEFGHIJKL'.split('');

const POLL = {
  LIVE: 5_000,
  SOON: 12_000,
  IDLE: 30_000,
};

const state = {
  teamsMap: {},
  groups: [],
  games: [],
  thirdPlaceRankings: [],
  teamStatusMap: {},
  selectedGroup: 'ALL',
  hasLive: false,
  hasSoon: false,
  lastFetch: null,
  pollTimer: null,
  tickTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── API ──────────────────────────────────────────────────────────

async function fetchJSON(endpoint) {
  const res = await fetch(`${API_BASE}/${endpoint}`);
  if (!res.ok) throw new Error(`Failed to fetch ${endpoint}: ${res.status}`);
  return res.json();
}

// ── Date / time helpers ──────────────────────────────────────────

function parseGameDate(dateStr) {
  const [datePart, timePart] = dateStr.split(' ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute] = (timePart || '00:00').split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0);
}

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatKickoff(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatTodayTitle() {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Match status ─────────────────────────────────────────────────

function normalizeElapsed(raw) {
  return (raw || '').toLowerCase().replace(/\s+/g, '');
}

function isGameLive(game) {
  if (game.finished === 'TRUE') return false;
  const e = normalizeElapsed(game.time_elapsed);
  if (e === 'notstarted' || e === 'finished' || !e) {
    const start = parseGameDate(game.local_date);
    const now = new Date();
    const end = new Date(start.getTime() + 2.5 * 60 * 60 * 1000);
    const inWindow = now >= start && now <= end;
    const hasScore = game.home_score !== 'null' && game.away_score !== 'null';
    return inWindow && hasScore;
  }
  return true;
}

function isGameSoon(game) {
  if (game.finished === 'TRUE' || isGameLive(game)) return false;
  const diff = parseGameDate(game.local_date) - new Date();
  return diff > 0 && diff <= 2 * 60 * 60 * 1000;
}

function getElapsedDisplay(game) {
  const e = normalizeElapsed(game.time_elapsed);
  if (game.finished === 'TRUE' || e === 'finished') return 'FT';
  if (e === 'notstarted' || !e) {
    if (isGameLive(game)) return estimateMinute(game);
    return null;
  }
  if (e === 'ht' || e === 'halftime') return 'HT';
  const match = e.match(/(\d+)/);
  return match ? `${match[1]}′` : e.toUpperCase();
}

function estimateMinute(game) {
  const start = parseGameDate(game.local_date);
  const mins = Math.floor((Date.now() - start.getTime()) / 60_000);
  if (mins < 0) return null;
  if (mins <= 45) return `${mins}′`;
  if (mins <= 60) return 'HT';
  if (mins <= 105) return `${mins - 15}′`;
  return '90+′';
}

function getMatchPhase(game) {
  if (game.finished === 'TRUE') return 'finished';
  if (isGameLive(game)) return 'live';
  if (parseGameDate(game.local_date) > new Date()) return 'upcoming';
  return 'finished';
}

function getStageLabel(game) {
  const type = (game.type || '').toLowerCase();
  if (type === 'group') return `Group ${game.group} · Matchday ${game.matchday}`;
  const labels = {
    r32: 'Round of 32',
    r16: 'Round of 16',
    qf: 'Quarter-Final',
    sf: 'Semi-Final',
    third: '3rd Place',
    final: 'Final',
  };
  return labels[type] || type.replace(/_/g, ' ').toUpperCase() || 'Knockout';
}

function getScore(game) {
  const home = game.home_score;
  const away = game.away_score;
  if (home === 'null' || away === 'null') return null;
  return { home: home ?? '-', away: away ?? '-' };
}

// ── Standings logic ──────────────────────────────────────────────

function sortTeams(teams) {
  return [...teams].sort((a, b) => {
    const pts = Number(b.pts) - Number(a.pts);
    if (pts) return pts;
    const gd = Number(b.gd) - Number(a.gd);
    if (gd) return gd;
    return Number(b.gf) - Number(a.gf);
  });
}

function computeThirdPlaceRankings(groups) {
  const thirds = groups.map((g) => {
    const sorted = sortTeams(g.teams);
    const third = sorted[2];
    return third
      ? {
          ...third,
          group: g.name,
          team: state.teamsMap[third.team_id],
        }
      : null;
  }).filter(Boolean);

  return thirds.sort((a, b) => {
    const pts = Number(b.pts) - Number(a.pts);
    if (pts) return pts;
    const gd = Number(b.gd) - Number(a.gd);
    if (gd) return gd;
    return Number(b.gf) - Number(a.gf);
  });
}

function buildTeamStatusMap(groups, thirdRankings) {
  const map = {};
  const thirdQualified = new Set(
    thirdRankings.slice(0, 8).map((t) => t.team_id)
  );

  groups.forEach((group) => {
    const sorted = sortTeams(group.teams);
    sorted.forEach((team, i) => {
      const rank = i + 1;
      let zone, statusLabel, statusClass;

      if (rank <= 2) {
        zone = 'zone-r32';
        statusLabel = 'R32';
        statusClass = 'r32';
      } else if (rank === 3) {
        if (thirdQualified.has(team.team_id)) {
          zone = 'zone-third-in';
          statusLabel = 'R32';
          statusClass = 'third-in';
        } else {
          zone = 'zone-third-out';
          statusLabel = 'OUT';
          statusClass = 'third-out';
        }
      } else {
        zone = 'zone-elim';
        statusLabel = 'OUT';
        statusClass = 'elim';
      }

      map[team.team_id] = { zone, statusLabel, statusClass, rank, group: group.name };
    });
  });

  return map;
}

// ── Render helpers ───────────────────────────────────────────────

function teamFlag(teamId) {
  const t = state.teamsMap[teamId];
  return t?.flag || '';
}

function teamName(teamId, fallback) {
  return state.teamsMap[teamId]?.name_en || fallback || 'TBD';
}

function renderMatchRow(game) {
  const phase = getMatchPhase(game);
  const start = parseGameDate(game.local_date);
  const score = getScore(game);
  const elapsed = getElapsedDisplay(game);
  const homeFlag = teamFlag(game.home_team_id);
  const awayFlag = teamFlag(game.away_team_id);
  const homeName = game.home_team_name_en || teamName(game.home_team_id);
  const awayName = game.away_team_name_en || teamName(game.away_team_id);

  let countdownText = '';
  let countdownClass = 'match-countdown';

  if (phase === 'live') {
    countdownText = elapsed ? `LIVE ${elapsed}` : 'LIVE';
    countdownClass += ' live-text';
  } else if (phase === 'upcoming') {
    const diff = start - new Date();
    countdownText = diff > 0 ? `Starts in ${formatCountdown(diff)}` : 'Starting soon';
    countdownClass += '';
  } else {
    countdownText = 'Full Time';
    countdownClass += ' finished-text';
  }

  const scoreHtml = score
    ? `<span class="match-score-display">${score.home}<span class="sep">–</span>${score.away}</span>`
    : `<span class="match-score-display" style="font-size:1rem;color:var(--text-dim)">vs</span>`;

  const badgeClass =
    phase === 'live' ? 'live' : phase === 'upcoming' ? 'upcoming' : 'ft';
  const badgeText =
    phase === 'live' ? (elapsed || 'LIVE') : phase === 'upcoming' ? 'Upcoming' : 'FT';

  return `
    <article class="match-row ${phase}" data-game-id="${game.id}">
      <div class="match-time-col">
        <time class="match-kickoff" datetime="${start.toISOString()}">${formatKickoff(start)}</time>
        <span class="${countdownClass}" data-countdown="${game.id}">${countdownText}</span>
      </div>
      <div class="match-info-col">
        <span class="match-stage-label">${getStageLabel(game)}</span>
        <div class="match-teams-row">
          <span class="match-team">
            ${homeFlag ? `<img src="${homeFlag}" alt="" loading="lazy" width="28" height="20">` : ''}
            ${homeName}
          </span>
          <span class="match-vs">vs</span>
          <span class="match-team">
            ${awayFlag ? `<img src="${awayFlag}" alt="" loading="lazy" width="28" height="20">` : ''}
            ${awayName}
          </span>
        </div>
      </div>
      <div class="match-score-col">
        ${scoreHtml}
        <span class="match-minute-badge ${badgeClass}">${badgeText}</span>
      </div>
    </article>`;
}

function renderToday() {
  const now = new Date();
  const todayGames = state.games
    .filter((g) => isSameCalendarDay(parseGameDate(g.local_date), now))
    .sort((a, b) => parseGameDate(a.local_date) - parseGameDate(b.local_date));

  $('#today-title').textContent = formatTodayTitle();
  $('#today-meta').textContent =
    todayGames.length === 0
      ? 'No matches scheduled today'
      : `${todayGames.length} match${todayGames.length !== 1 ? 'es' : ''} · Local time`;

  const container = $('#today-timeline');
  $('#today-loading')?.remove();

  if (todayGames.length === 0) {
    container.innerHTML = `<p class="today-empty">No World Cup matches on the schedule for today. Check back on match days.</p>`;
    return;
  }

  container.innerHTML = todayGames.map(renderMatchRow).join('');
}

function renderLiveBanner() {
  const liveGames = state.games.filter(isGameLive);
  const banner = $('#live-banner');
  const inner = $('#live-banner-matches');

  if (liveGames.length === 0) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  inner.innerHTML = liveGames
    .map((g) => {
      const score = getScore(g);
      const elapsed = getElapsedDisplay(g) || 'LIVE';
      const home = g.home_team_name_en || teamName(g.home_team_id);
      const away = g.away_team_name_en || teamName(g.away_team_id);
      const scoreStr = score ? `${score.home}–${score.away}` : 'vs';
      return `
        <div class="live-ticker-match">
          <span class="minute">${elapsed}</span>
          <span>${home}</span>
          <span class="score">${scoreStr}</span>
          <span>${away}</span>
        </div>`;
    })
    .join('');
}

function renderHeaderStats() {
  const now = new Date();
  const todayCount = state.games.filter((g) =>
    isSameCalendarDay(parseGameDate(g.local_date), now)
  ).length;
  const liveCount = state.games.filter(isGameLive).length;
  const upcomingToday = state.games.filter(
    (g) =>
      isSameCalendarDay(parseGameDate(g.local_date), now) &&
      getMatchPhase(g) === 'upcoming'
  ).length;

  $('#header-stats').innerHTML = `
    <span class="stat-chip ${liveCount ? 'live' : ''}">
      ${liveCount ? '<span class="pulse"></span>' : ''}
      <strong>${liveCount}</strong> live
    </span>
    <span class="stat-chip"><strong>${todayCount}</strong> today</span>
    <span class="stat-chip"><strong>${upcomingToday}</strong> upcoming</span>`;

  const liveInd = $('#live-indicator');
  liveInd.hidden = liveCount === 0;
  $('#live-count-label').textContent = `${liveCount} Live`;
}

function renderRankRow(team, rank, status) {
  const gd = Number(team.gd);
  const gdClass = gd > 0 ? 'gd-pos' : gd < 0 ? 'gd-neg' : '';
  const flag = teamFlag(team.team_id);
  const name = teamName(team.team_id);
  const barWidth = ((5 - rank) / 4) * 100;

  return `
    <div class="rank-row ${status.zone}" title="${status.statusLabel === 'R32' && status.rank === 3 ? 'Advances as a top-8 third-place team' : status.statusLabel === 'OUT' ? 'Eliminated' : 'Advances to Round of 32'}">
      <span class="rank-pos">${rank}</span>
      <div class="rank-team">
        ${flag ? `<img src="${flag}" alt="" loading="lazy">` : ''}
        <span class="rank-team-name">${name}</span>
        <span class="rank-status ${status.statusClass}">${status.statusLabel}</span>
      </div>
      <span class="rank-stat">${team.mp}</span>
      <span class="rank-stat">${team.w}</span>
      <span class="rank-stat">${team.d}</span>
      <span class="rank-stat">${team.l}</span>
      <span class="rank-stat ${gdClass}">${gd > 0 ? '+' : ''}${team.gd}</span>
      <span class="rank-stat pts">${team.pts}</span>
      <div class="rank-bar-wrap" aria-hidden="true">
        <div class="rank-bar" style="width:${barWidth}%"></div>
      </div>
    </div>`;
}

function renderGroupCardFixed(group) {
  const sorted = sortTeams(group.teams);
  const rowHtml = sorted
    .map((t, i) => renderRankRow(t, i + 1, state.teamStatusMap[t.team_id]))
    .join('');

  const r32Rows = sorted
    .slice(0, 2)
    .map((t, i) => renderRankRow(t, i + 1, state.teamStatusMap[t.team_id]))
    .join('');
  const thirdRow = sorted[2]
    ? renderRankRow(sorted[2], 3, state.teamStatusMap[sorted[2].team_id])
    : '';
  const elimRow = sorted[3]
    ? renderRankRow(sorted[3], 4, state.teamStatusMap[sorted[3].team_id])
    : '';

  return `
    <div class="group-standings-card">
      <div class="group-standings-head">
        <h3>Group ${group.name}</h3>
        <span>Final standings</span>
      </div>
      <div class="rank-header">
        <span>#</span><span>Team</span>
        <span>MP</span><span>W</span><span>D</span><span>L</span><span>GD</span><span>Pts</span>
      </div>
      <div class="rank-rows">
        <div class="zone-divider"><span class="line"></span>Round of 32 — Top 2<span class="line"></span></div>
        ${r32Rows}
        <div class="zone-divider"><span class="line"></span>3rd Place — Best 8 advance<span class="line"></span></div>
        ${thirdRow}
        <div class="zone-divider"><span class="line"></span>Eliminated<span class="line"></span></div>
        ${elimRow}
      </div>
    </div>`;
}

function renderStandings() {
  const layout = $('#standings-layout');
  $('#standings-loading')?.remove();

  const groups =
    state.selectedGroup === 'ALL'
      ? [...state.groups].sort(
          (a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name)
        )
      : state.groups.filter((g) => g.name === state.selectedGroup);

  const single = state.selectedGroup !== 'ALL';
  layout.innerHTML = `<div class="standings-grid ${single ? 'single' : ''}">${groups.map(renderGroupCardFixed).join('')}</div>`;
}

function renderGroupTabs() {
  const tabs = $('#group-tabs');
  const buttons = [
    `<button class="group-tab ${state.selectedGroup === 'ALL' ? 'active' : ''}" data-group="ALL" role="tab">All Groups</button>`,
    ...GROUP_ORDER.map(
      (g) =>
        `<button class="group-tab ${state.selectedGroup === g ? 'active' : ''}" data-group="${g}" role="tab">Group ${g}</button>`
    ),
  ];
  tabs.innerHTML = buttons.join('');

  tabs.querySelectorAll('.group-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedGroup = btn.dataset.group;
      tabs.querySelectorAll('.group-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderStandings();
    });
  });
}

function renderThirdPlace() {
  const board = $('#third-place-board');
  const rankings = state.thirdPlaceRankings;

  if (!rankings.length) {
    board.innerHTML = '<p class="today-empty">No third-place data available.</p>';
    return;
  }

  let tableRows = '';
  rankings.forEach((t, i) => {
    if (i === 8) {
      tableRows += `<tr class="cutoff-row"><td colspan="10">▲ Top 8 advance to Round of 32 · Bottom 4 eliminated ▼</td></tr>`;
    }
    const rank = i + 1;
    const qualified = rank <= 8;
    const gd = Number(t.gd);
    const gdClass = gd > 0 ? 'gd-pos' : gd < 0 ? 'gd-neg' : '';
    const name = t.team?.name_en || teamName(t.team_id);
    const flag = t.team?.flag || teamFlag(t.team_id);
    tableRows += `
      <tr class="${qualified ? 'qualified-row' : 'eliminated-row'}">
        <td class="third-rank">${rank}</td>
        <td>
          <div class="third-team-cell">
            ${flag ? `<img src="${flag}" alt="" loading="lazy">` : ''}
            <span class="name">${name}</span>
            <span class="group-tag">Grp ${t.group}</span>
          </div>
        </td>
        <td class="stat">${t.mp}</td>
        <td class="stat">${t.w}</td>
        <td class="stat">${t.d}</td>
        <td class="stat">${t.l}</td>
        <td class="stat">${t.gf}</td>
        <td class="stat">${t.ga}</td>
        <td class="stat ${gdClass}">${gd > 0 ? '+' : ''}${t.gd}</td>
        <td class="stat pts">${t.pts}</td>
      </tr>`;
  });

  board.innerHTML = `
    <table class="third-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Team</th>
          <th>MP</th>
          <th>W</th>
          <th>D</th>
          <th>L</th>
          <th>GF</th>
          <th>GA</th>
          <th>GD</th>
          <th>Pts</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>`;
}

// ── Live tick (every second) ─────────────────────────────────────

function tick() {
  $('#live-clock').textContent = new Date().toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  if (state.lastFetch) {
    const ago = Math.floor((Date.now() - state.lastFetch) / 1000);
    const sync = $('#sync-status');
    sync.textContent = `Synced ${ago}s ago`;
    sync.className = 'sync-status ' + (ago < 10 ? 'fresh' : ago < 30 ? '' : 'stale');
  }

  $$('[data-countdown]').forEach((el) => {
    const gameId = el.dataset.countdown;
    const game = state.games.find((g) => g.id === gameId);
    if (!game) return;

    const phase = getMatchPhase(game);
    if (phase === 'upcoming') {
      const diff = parseGameDate(game.local_date) - new Date();
      el.textContent = diff > 0 ? `Starts in ${formatCountdown(diff)}` : 'Starting soon';
    } else if (phase === 'live') {
      const elapsed = getElapsedDisplay(game);
      el.textContent = elapsed ? `LIVE ${elapsed}` : 'LIVE';
      el.className = 'match-countdown live-text';
    }
  });

  if (state.hasLive) {
    renderLiveBanner();
    $$('.match-row.live').forEach((row) => {
      const game = state.games.find((g) => g.id === row.dataset.gameId);
      if (!game) return;
      const badge = row.querySelector('.match-minute-badge');
      const elapsed = getElapsedDisplay(game);
      if (badge && elapsed) badge.textContent = elapsed;
      const score = getScore(game);
      if (score) {
        const display = row.querySelector('.match-score-display');
        if (display) {
          display.innerHTML = `${score.home}<span class="sep">–</span>${score.away}`;
        }
      }
    });
  }
}

// ── Polling ──────────────────────────────────────────────────────

function getPollInterval() {
  if (state.hasLive) return POLL.LIVE;
  if (state.hasSoon) return POLL.SOON;
  return POLL.IDLE;
}

function schedulePoll() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(loadData, getPollInterval());
}

function updateLiveFlags() {
  state.hasLive = state.games.some(isGameLive);
  state.hasSoon = state.games.some(isGameSoon);
}

// ── Data load ────────────────────────────────────────────────────

async function loadData() {
  const btn = $('#refresh-btn');
  btn?.classList.add('spinning');

  try {
    const [teamsData, groupsData, gamesData] = await Promise.all([
      fetchJSON('teams'),
      fetchJSON('groups'),
      fetchJSON('games'),
    ]);

    state.teamsMap = Object.fromEntries(teamsData.teams.map((t) => [t.id, t]));
    state.groups = groupsData.groups;
    state.games = gamesData.games;
    state.lastFetch = Date.now();

    state.thirdPlaceRankings = computeThirdPlaceRankings(state.groups);
    state.teamStatusMap = buildTeamStatusMap(state.groups, state.thirdPlaceRankings);
    updateLiveFlags();

    renderHeaderStats();
    renderLiveBanner();
    renderToday();
    renderStandings();
    renderThirdPlace();

    schedulePoll();
  } catch (err) {
    console.error(err);
    if (!state.groups.length) {
      $('#standings-layout').innerHTML = `
        <div class="error-state">
          <p>Could not load data. Check your connection.</p>
          <button onclick="loadData()">Try Again</button>
        </div>`;
    }
  } finally {
    btn?.classList.remove('spinning');
  }
}

// ── Nav scroll spy ───────────────────────────────────────────────

function initNav() {
  const links = $$('.nav-link');
  const sections = ['today', 'standings', 'third-place'].map((id) => document.getElementById(id));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          links.forEach((l) => l.classList.remove('active'));
          const active = document.querySelector(`.nav-link[data-section="${entry.target.id}"]`);
          active?.classList.add('active');
        }
      });
    },
    { rootMargin: '-40% 0px -50% 0px' }
  );

  sections.forEach((s) => s && observer.observe(s));
}

// ── Init ─────────────────────────────────────────────────────────

$('#refresh-btn')?.addEventListener('click', loadData);
renderGroupTabs();
initNav();
state.tickTimer = setInterval(tick, 1000);
loadData();