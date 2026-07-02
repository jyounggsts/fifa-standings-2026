const API_BASE = 'https://worldcup26.ir/get';
const GROUP_ORDER = 'ABCDEFGHIJKL'.split('');

const POLL = { LIVE: 5_000, SOON: 12_000, IDLE: 30_000 };

const BRACKET_ROUNDS = [
  { type: 'r32', label: 'Round of 32' },
  { type: 'r16', label: 'Round of 16' },
  { type: 'qf', label: 'Quarter-Finals' },
  { type: 'sf', label: 'Semi-Finals' },
  { type: 'final', label: 'Final' },
];

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

// ── Date / time ──────────────────────────────────────────────────

function parseGameDate(dateStr) {
  const [datePart, timePart] = dateStr.split(' ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute] = (timePart || '00:00').split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0);
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatKickoff(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatCountdown(ms) {
  if (ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Match status & scores ────────────────────────────────────────

function normalizeElapsed(raw) {
  return (raw || '').toLowerCase().replace(/\s+/g, '');
}

function isNotStarted(game) {
  const e = normalizeElapsed(game.time_elapsed);
  return !e || e === 'notstarted';
}

function isScoreNull(val) {
  return val === null || val === undefined || val === 'null' || val === '';
}

function scoresArePlayable(game) {
  return !isScoreNull(game.home_score) && !isScoreNull(game.away_score);
}

function shouldShowScore(game) {
  if (game.finished === 'TRUE') return scoresArePlayable(game);
  if (isNotStarted(game)) return false;
  return scoresArePlayable(game);
}

function isGameLive(game) {
  if (game.finished === 'TRUE') return false;
  const e = normalizeElapsed(game.time_elapsed);
  if (e === 'notstarted' || e === 'finished' || !e) return false;
  if (e === 'ht' || e === 'halftime') return true;
  return /\d/.test(e);
}

function isGameSoon(game) {
  if (game.finished === 'TRUE' || isGameLive(game)) return false;
  const diff = parseGameDate(game.local_date) - Date.now();
  return diff > 0 && diff <= 2 * 60 * 60 * 1000;
}

function getElapsedDisplay(game) {
  const e = normalizeElapsed(game.time_elapsed);
  if (game.finished === 'TRUE' || e === 'finished') return 'FT';
  if (e === 'notstarted' || !e) return null;
  if (e === 'ht' || e === 'halftime') return 'HT';
  const stoppage = e.match(/(\d+)\+(\d+)/);
  if (stoppage) return `${stoppage[1]}+${stoppage[2]}'`;
  const minute = e.match(/(\d+)/);
  return minute ? `${minute[1]}'` : e.toUpperCase();
}

function getMatchPhase(game) {
  if (game.finished === 'TRUE') return 'finished';
  if (isGameLive(game)) return 'live';
  return 'upcoming';
}

function getStageLabel(game) {
  const type = (game.type || '').toLowerCase();
  if (type === 'group') return `Group ${game.group} MD${game.matchday}`;
  const labels = {
    r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-Final',
    sf: 'Semi-Final', third: '3rd Place', final: 'Final',
  };
  return labels[type] || type.toUpperCase();
}

function getScore(game) {
  if (!shouldShowScore(game)) return null;
  const result = { home: String(game.home_score), away: String(game.away_score) };
  const hPen = game.home_penalty_score;
  const aPen = game.away_penalty_score;
  if (game.finished === 'TRUE' && !isScoreNull(hPen) && !isScoreNull(aPen)) {
    result.pens = { home: String(hPen), away: String(aPen) };
  }
  return result;
}

function getMatchWinnerSide(game) {
  if (game.finished !== 'TRUE') return null;
  const h = Number(game.home_score);
  const a = Number(game.away_score);
  if (isNaN(h) || isNaN(a)) return null;
  if (h > a) return 'home';
  if (a > h) return 'away';
  const hPen = Number(game.home_penalty_score);
  const aPen = Number(game.away_penalty_score);
  if (!isNaN(hPen) && !isNaN(aPen)) return hPen > aPen ? 'home' : 'away';
  return null;
}

function formatScoreCompact(score) {
  if (!score) return 'vs';
  let s = `${score.home}-${score.away}`;
  if (score.pens) s += ` (${score.pens.home}-${score.pens.away} pens)`;
  return s;
}

// ── Standings ────────────────────────────────────────────────────

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
  return groups.map((g) => {
    const third = sortTeams(g.teams)[2];
    return third ? { ...third, group: g.name, team: state.teamsMap[third.team_id] } : null;
  }).filter(Boolean).sort((a, b) => {
    const pts = Number(b.pts) - Number(a.pts);
    if (pts) return pts;
    return Number(b.gd) - Number(a.gd) || Number(b.gf) - Number(a.gf);
  });
}

function buildTeamStatusMap(groups, thirdRankings) {
  const map = {};
  const thirdQ = new Set(thirdRankings.slice(0, 8).map((t) => t.team_id));
  groups.forEach((group) => {
    sortTeams(group.teams).forEach((team, i) => {
      const rank = i + 1;
      let zone, statusClass;
      if (rank <= 2) { zone = 'zone-r32'; statusClass = 'r32'; }
      else if (rank === 3) {
        zone = thirdQ.has(team.team_id) ? 'zone-third-in' : 'zone-third-out';
        statusClass = thirdQ.has(team.team_id) ? 'third-in' : 'third-out';
      } else { zone = 'zone-elim'; statusClass = 'elim'; }
      map[team.team_id] = { zone, statusClass, rank, group: group.name };
    });
  });
  return map;
}

// ── Helpers ──────────────────────────────────────────────────────

function teamFlag(teamId) {
  return state.teamsMap[teamId]?.flag || '';
}

function teamName(teamId, fallback) {
  const n = state.teamsMap[teamId]?.name_en || fallback;
  return n && n !== '0' ? n : '';
}

function flagImg(teamId, cls = '') {
  const f = teamFlag(teamId);
  return f ? `<img src="${f}" alt="" loading="lazy" class="${cls}">` : '<span class="ph-flag"></span>';
}

function isTbd(teamId, name) {
  return !teamId || teamId === '0' || !name;
}

// ── Eliminations ─────────────────────────────────────────────────

function buildEliminations() {
  const elim = [];

  state.groups.forEach((group) => {
    const sorted = sortTeams(group.teams);
    const fourth = sorted[3];
    if (fourth) {
      elim.push({
        teamId: fourth.team_id,
        name: teamName(fourth.team_id),
        flag: teamFlag(fourth.team_id),
        round: 'Group Stage',
        detail: `Finished 4th in Group ${group.name}`,
        by: null, byFlag: null, score: null,
        sortKey: `A-${group.name}`,
      });
    }
    const third = sorted[2];
    const st = state.teamStatusMap[third?.team_id];
    if (third && st?.statusClass === 'third-out') {
      elim.push({
        teamId: third.team_id,
        name: teamName(third.team_id),
        flag: teamFlag(third.team_id),
        round: 'Group Stage',
        detail: `3rd in Group ${group.name} — missed top-8 cut`,
        by: null, byFlag: null, score: null,
        sortKey: `B-${group.name}`,
      });
    }
  });

  ['r32', 'r16', 'qf', 'sf', 'third'].forEach((type) => {
    state.games
      .filter((g) => g.type === type && g.finished === 'TRUE')
      .forEach((game) => {
        const winSide = getMatchWinnerSide(game);
        if (!winSide) return;
        const loseSide = winSide === 'home' ? 'away' : 'home';
        const loserId = loseSide === 'home' ? game.home_team_id : game.away_team_id;
        const winnerId = winSide === 'home' ? game.home_team_id : game.away_team_id;
        const loserName = loseSide === 'home' ? game.home_team_name_en : game.away_team_name_en;
        const winnerName = winSide === 'home' ? game.home_team_name_en : game.away_team_name_en;
        const score = getScore(game);
        elim.push({
          teamId: loserId,
          name: loserName || teamName(loserId),
          flag: teamFlag(loserId),
          round: getStageLabel(game),
          detail: `Eliminated in ${getStageLabel(game)}`,
          by: winnerName || teamName(winnerId),
          byFlag: teamFlag(winnerId),
          score: score ? formatScoreCompact(score) : '',
          sortKey: `C-${game.id}`,
          date: game.local_date,
        });
      });
  });

  return elim.filter((e) => e.name);
}

function buildAtRisk() {
  const risks = [];
  const koTypes = ['r32', 'r16', 'qf', 'sf', 'final', 'third'];
  const seen = new Set();

  state.games
    .filter((g) => koTypes.includes(g.type) && g.finished !== 'TRUE')
    .sort((a, b) => parseGameDate(a.local_date) - parseGameDate(b.local_date))
    .forEach((game) => {
      [['home', game.home_team_id, game.home_team_name_en],
       ['away', game.away_team_id, game.away_team_name_en]].forEach(([, id, name]) => {
        if (isTbd(id, name) || seen.has(id)) return;
        seen.add(id);
        risks.push({
          teamId: id,
          name: name || teamName(id),
          flag: teamFlag(id),
          match: game,
          opponent: id === game.home_team_id
            ? (game.away_team_name_en || teamName(game.away_team_id))
            : (game.home_team_name_en || teamName(game.home_team_id)),
          opponentFlag: id === game.home_team_id ? teamFlag(game.away_team_id) : teamFlag(game.home_team_id),
          round: getStageLabel(game),
          date: game.local_date,
          phase: getMatchPhase(game),
        });
      });
    });

  return risks;
}

// ── StreamEast cards ─────────────────────────────────────────────

function renderStreamCard(game) {
  const phase = getMatchPhase(game);
  const score = getScore(game);
  const elapsed = getElapsedDisplay(game);
  const start = parseGameDate(game.local_date);
  const homeId = game.home_team_id;
  const awayId = game.away_team_id;
  const homeName = game.home_team_name_en || teamName(homeId) || 'TBD';
  const awayName = game.away_team_name_en || teamName(awayId) || 'TBD';

  let footText = '';
  if (phase === 'live') footText = elapsed ? `LIVE ${elapsed}` : 'LIVE';
  else if (phase === 'upcoming') {
    const diff = start - Date.now();
    footText = diff > 0 ? `Starts in ${formatCountdown(diff)}` : isNotStarted(game) ? 'Awaiting kickoff' : 'Starting soon';
  } else footText = 'Full Time';

  const pensHtml = score?.pens
    ? `<span class="se-pens">(${score.pens.home}-${score.pens.away} pens)</span>` : '';

  return `
    <article class="se-card ${phase}" data-game-id="${game.id}">
      <div class="se-card-bar"></div>
      <div class="se-card-top">
        <span class="se-league">${getStageLabel(game)}</span>
        ${phase === 'live' ? '<span class="se-live-tag">LIVE</span>' : ''}
        <span class="se-kick">${formatKickoff(start)}</span>
      </div>
      <div class="se-body">
        <div class="se-side">
          ${flagImg(homeId)}
          <span class="se-team">${homeName}</span>
          <span class="se-score">${score ? score.home : ''}</span>
        </div>
        <div class="se-mid">
          <span class="se-vs">${score ? '-' : 'vs'}</span>
          ${pensHtml}
        </div>
        <div class="se-side">
          ${flagImg(awayId)}
          <span class="se-team">${awayName}</span>
          <span class="se-score">${score ? score.away : ''}</span>
        </div>
      </div>
      <div class="se-foot ${phase === 'live' ? 'live-text' : ''}" data-countdown="${game.id}">${footText}</div>
    </article>`;
}

function renderToday() {
  const now = new Date();
  const todayGames = state.games
    .filter((g) => isSameCalendarDay(parseGameDate(g.local_date), now))
    .sort((a, b) => parseGameDate(a.local_date) - parseGameDate(b.local_date));

  const meta = $('#today-meta');
  if (meta) {
    meta.textContent = todayGames.length
      ? `${todayGames.length} match${todayGames.length !== 1 ? 'es' : ''} today`
      : 'No matches today';
  }

  const container = $('#today-timeline');
  $('#today-loading')?.remove();

  if (!todayGames.length) {
    container.innerHTML = '<p class="empty-msg">No matches scheduled for today.</p>';
    return;
  }
  container.innerHTML = todayGames.map(renderStreamCard).join('');
}

function renderLiveBanner() {
  const liveGames = state.games.filter(isGameLive);
  const banner = $('#live-banner');
  const inner = $('#live-banner-matches');
  if (!liveGames.length) { banner.hidden = true; return; }
  banner.hidden = false;
  inner.innerHTML = liveGames.map((g) => {
    const elapsed = getElapsedDisplay(g) || 'LIVE';
    const home = g.home_team_name_en || teamName(g.home_team_id);
    const away = g.away_team_name_en || teamName(g.away_team_id);
    return `<span class="ticker-item"><span class="min">${elapsed}</span><span>${home}</span><span class="sc">${formatScoreCompact(getScore(g))}</span><span>${away}</span></span>`;
  }).join('');
}

function renderHeaderStats() {
  const liveCount = state.games.filter(isGameLive).length;
  const liveInd = $('#live-indicator');
  if (liveInd) {
    liveInd.hidden = liveCount === 0;
    const lbl = $('#live-count-label');
    if (lbl) lbl.textContent = `${liveCount} LIVE`;
  }
}

// ── Bracket ──────────────────────────────────────────────────────

function renderBracketTeam(game, side, winnerSide, phase) {
  const isHome = side === 'home';
  const teamId = isHome ? game.home_team_id : game.away_team_id;
  const name = isHome
    ? (game.home_team_name_en || teamName(teamId))
    : (game.away_team_name_en || teamName(teamId));
  const score = getScore(game);
  const scoreVal = score ? (isHome ? score.home : score.away) : '';

  let cls = 'b-team';
  if (isTbd(teamId, name)) cls += ' tbd';
  else if (game.finished === 'TRUE' && winnerSide) {
    cls += winnerSide === side ? ' winner' : ' eliminated';
  } else if (phase === 'live') {
    cls += ' live-team';
  } else if (phase === 'upcoming') {
    cls += ' at-risk';
  }

  return `
    <div class="${cls}">
      ${flagImg(teamId)}
      <span class="b-name">${name || 'TBD'}</span>
      ${scoreVal !== '' ? `<span class="b-score">${scoreVal}</span>` : ''}
    </div>`;
}

function renderBracketMatch(game) {
  const phase = getMatchPhase(game);
  const winnerSide = getMatchWinnerSide(game);
  return `
    <div class="b-match ${phase}" data-game-id="${game.id}">
      <div class="b-match-id">${getStageLabel(game)} #${game.id}</div>
      ${renderBracketTeam(game, 'home', winnerSide, phase)}
      ${renderBracketTeam(game, 'away', winnerSide, phase)}
    </div>`;
}

function renderBracket() {
  const board = $('#bracket-board');
  if (!board) return;

  const thirdGame = state.games.find((g) => g.type === 'third');
  const rounds = BRACKET_ROUNDS.map((r) => {
    const games = state.games
      .filter((g) => g.type === r.type)
      .sort((a, b) => Number(a.id) - Number(b.id));
    return { ...r, games };
  });

  let html = '';
  rounds.forEach((round) => {
    html += `
      <div class="bracket-round">
        <div class="round-label">${round.label}</div>
        <div class="round-matches">
          ${round.games.map(renderBracketMatch).join('')}
        </div>
      </div>`;
  });

  if (thirdGame) {
    html += `
      <div class="bracket-round">
        <div class="round-label">3rd Place</div>
        <div class="round-matches">${renderBracketMatch(thirdGame)}</div>
      </div>`;
  }

  board.innerHTML = html;
}

// ── Eliminations UI ──────────────────────────────────────────────

function renderEliminations() {
  const elim = buildEliminations();
  const list = $('#elim-list');
  const count = $('#elim-count');
  if (count) count.textContent = elim.length;

  if (!list) return;
  if (!elim.length) {
    list.innerHTML = '<p class="empty-msg">No eliminations yet.</p>';
    return;
  }

  list.innerHTML = elim.map((e) => `
    <div class="elim-item">
      ${e.flag ? `<img src="${e.flag}" alt="">` : '<span class="ph-flag"></span>'}
      <div class="elim-info">
        <div class="elim-name">${e.name}</div>
        <div class="elim-detail">${e.detail}</div>
        ${e.by ? `<div class="elim-by">${e.byFlag ? `<img src="${e.byFlag}" alt="">` : ''}Lost to ${e.by}</div>` : ''}
      </div>
      ${e.score ? `<span class="elim-score">${e.score}</span>` : ''}
      <span class="elim-round">${e.round}</span>
    </div>`).join('');
}

function renderAtRisk() {
  const risks = buildAtRisk();
  const list = $('#risk-list');
  const count = $('#risk-count');
  if (count) count.textContent = risks.length;

  if (!list) return;
  if (!risks.length) {
    list.innerHTML = '<p class="empty-msg">No upcoming knockout matches.</p>';
    return;
  }

  list.innerHTML = risks.map((r) => {
    const start = parseGameDate(r.date);
    const phase = r.phase;
    const statusText = phase === 'live' ? 'LIVE NOW' : `Next: ${formatKickoff(start)}`;
    return `
      <div class="risk-item">
        ${r.flag ? `<img src="${r.flag}" alt="">` : '<span class="ph-flag"></span>'}
        <div class="risk-info">
          <div class="risk-name">${r.name}</div>
          <div class="risk-detail">${r.round} vs ${r.opponent} · ${statusText}</div>
        </div>
        ${r.opponentFlag ? `<img src="${r.opponentFlag}" alt="" style="width:20px;height:14px;border-radius:2px">` : ''}
      </div>`;
  }).join('');
}

// ── Standings (compact) ────────────────────────────────────────

function renderGroupCard(group) {
  const sorted = sortTeams(group.teams);
  const rows = sorted.map((t, i) => {
    const st = state.teamStatusMap[t.team_id];
    const gd = Number(t.gd);
    return `
      <div class="grp-row ${st?.zone || ''}">
        <span class="grp-rank">${i + 1}</span>
        <div class="grp-team">
          ${flagImg(t.team_id)}
          <span class="grp-name">${teamName(t.team_id)}</span>
        </div>
        <span class="grp-stat">${t.w}</span>
        <span class="grp-stat">${t.d}</span>
        <span class="grp-stat pts">${t.pts}</span>
      </div>`;
  }).join('');

  return `
    <div class="grp-card">
      <div class="grp-head">Group ${group.name}</div>
      <div class="grp-header"><span>#</span><span>Team</span><span>W</span><span>D</span><span>Pts</span></div>
      ${rows}
    </div>`;
}

function renderStandings() {
  const layout = $('#standings-layout');
  $('#standings-loading')?.remove();
  const groups = state.selectedGroup === 'ALL'
    ? [...state.groups].sort((a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name))
    : state.groups.filter((g) => g.name === state.selectedGroup);
  const single = state.selectedGroup !== 'ALL';
  layout.innerHTML = `<div class="standings-grid ${single ? 'single' : ''}">${groups.map(renderGroupCard).join('')}</div>`;
}

function renderGroupTabs() {
  const tabs = $('#group-tabs');
  if (!tabs) return;
  tabs.innerHTML = [
    `<button class="group-tab ${state.selectedGroup === 'ALL' ? 'active' : ''}" data-group="ALL">All</button>`,
    ...GROUP_ORDER.map((g) =>
      `<button class="group-tab ${state.selectedGroup === g ? 'active' : ''}" data-group="${g}">Grp ${g}</button>`
    ),
  ].join('');
  tabs.querySelectorAll('.group-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedGroup = btn.dataset.group;
      tabs.querySelectorAll('.group-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderStandings();
    });
  });
}

// ── Live tick ────────────────────────────────────────────────────

function tick() {
  const clock = $('#live-clock');
  if (clock) {
    clock.textContent = new Date().toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  if (state.lastFetch) {
    const ago = Math.floor((Date.now() - state.lastFetch) / 1000);
    const sync = $('#sync-status');
    if (sync) {
      sync.textContent = `Synced ${ago}s ago`;
      sync.className = 'sync-tag ' + (ago < 10 ? 'fresh' : '');
    }
  }

  $$('[data-countdown]').forEach((el) => {
    const game = state.games.find((g) => g.id === el.dataset.countdown);
    if (!game) return;
    const phase = getMatchPhase(game);
    if (phase === 'upcoming') {
      const diff = parseGameDate(game.local_date) - Date.now();
      el.textContent = diff > 0 ? `Starts in ${formatCountdown(diff)}` : isNotStarted(game) ? 'Awaiting kickoff' : 'Starting soon';
    } else if (phase === 'live') {
      const elapsed = getElapsedDisplay(game);
      el.textContent = elapsed ? `LIVE ${elapsed}` : 'LIVE';
      el.className = 'se-foot live-text';
    }
  });

  if (state.hasLive) {
    renderLiveBanner();
    $$('.se-card.live, .b-match.live').forEach((card) => {
      const game = state.games.find((g) => g.id === card.dataset.gameId);
      if (!game) return;
      const score = getScore(game);
      if (card.classList.contains('se-card') && score) {
        const scores = card.querySelectorAll('.se-score');
        if (scores[0]) scores[0].textContent = score.home;
        if (scores[1]) scores[1].textContent = score.away;
      }
    });
  }
}

// ── Polling & load ───────────────────────────────────────────────

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

async function loadData() {
  const btn = $('#refresh-btn');
  btn?.classList.add('spinning');
  try {
    const [teamsData, groupsData, gamesData] = await Promise.all([
      fetchJSON('teams'), fetchJSON('groups'), fetchJSON('games'),
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
    renderBracket();
    renderEliminations();
    renderAtRisk();
    renderStandings();
    schedulePoll();
  } catch (err) {
    console.error(err);
    const layout = $('#standings-layout');
    if (layout && !state.groups.length) {
      layout.innerHTML = '<p class="empty-msg">Could not load data. <button onclick="loadData()">Retry</button></p>';
    }
  } finally {
    btn?.classList.remove('spinning');
  }
}

// ── Nav ──────────────────────────────────────────────────────────

function initNav() {
  const links = $$('.topnav-link');
  const sections = ['live', 'bracket', 'eliminated', 'standings']
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        links.forEach((l) => l.classList.remove('active'));
        document.querySelector(`.topnav-link[data-section="${entry.target.id}"]`)?.classList.add('active');
      }
    });
  }, { rootMargin: '-30% 0px -55% 0px' });

  sections.forEach((s) => observer.observe(s));
}

// ── Init ─────────────────────────────────────────────────────────

$('#refresh-btn')?.addEventListener('click', loadData);
renderGroupTabs();
initNav();
state.tickTimer = setInterval(tick, 1000);
loadData();