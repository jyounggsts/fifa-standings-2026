const API_BASE = 'https://worldcup26.ir/get';
const REFRESH_INTERVAL_MS = 60_000;
const LIVE_REFRESH_INTERVAL_MS = 30_000;

const GROUP_ORDER = 'ABCDEFGHIJKL'.split('');

let teamsMap = {};
let refreshTimer = null;
let hasLiveMatches = false;

const $ = (sel) => document.querySelector(sel);

async function fetchJSON(endpoint) {
  const res = await fetch(`${API_BASE}/${endpoint}`);
  if (!res.ok) throw new Error(`Failed to fetch ${endpoint}: ${res.status}`);
  return res.json();
}

function parseGameDate(dateStr) {
  const [datePart, timePart] = dateStr.split(' ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

function isGameLive(game) {
  if (game.finished === 'TRUE') return false;
  const elapsed = (game.time_elapsed || '').toLowerCase();
  if (elapsed && elapsed !== 'finished' && elapsed !== 'not started') return true;
  const start = parseGameDate(game.local_date);
  const now = new Date();
  const twoHoursLater = new Date(start.getTime() + 2.5 * 60 * 60 * 1000);
  return now >= start && now <= twoHoursLater;
}

function isGameUpcoming(game) {
  if (game.finished === 'TRUE') return false;
  if (isGameLive(game)) return false;
  return parseGameDate(game.local_date) > new Date();
}

function getMatchStatus(game) {
  if (game.finished === 'TRUE') return { label: 'FT', class: 'finished' };
  if (isGameLive(game)) {
    const elapsed = game.time_elapsed || 'LIVE';
    return { label: elapsed.toUpperCase(), class: 'live' };
  }
  return { label: 'Upcoming', class: 'upcoming' };
}

function formatMatchTime(dateStr) {
  const d = parseGameDate(dateStr);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getStageLabel(game) {
  if (game.type === 'group') return `Group ${game.group} · MD ${game.matchday}`;
  return game.type?.replace(/_/g, ' ') || 'Knockout';
}

function sortTeams(teams) {
  return [...teams].sort((a, b) => {
    const ptsDiff = Number(b.pts) - Number(a.pts);
    if (ptsDiff !== 0) return ptsDiff;
    const gdDiff = Number(b.gd) - Number(a.gd);
    if (gdDiff !== 0) return gdDiff;
    return Number(b.gf) - Number(a.gf);
  });
}

function renderTeamCell(teamId) {
  const team = teamsMap[teamId];
  if (!team) return `<span>Team ${teamId}</span>`;
  return `
    <div class="team-cell">
      <img src="${team.flag}" alt="" loading="lazy" width="24" height="16">
      <span>${team.name_en}</span>
    </div>`;
}

function renderStandings(groups) {
  const sorted = [...groups].sort(
    (a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name)
  );

  return sorted
    .map((group) => {
      const teams = sortTeams(group.teams);
      const rows = teams
        .map((t, i) => {
          const rank = i + 1;
          const rowClass =
            rank <= 2 ? 'qualified' : rank === 3 ? 'third-place' : '';
          const gd = Number(t.gd);
          const gdClass = gd > 0 ? 'gd-positive' : gd < 0 ? 'gd-negative' : '';

          return `
            <tr class="${rowClass}">
              <td class="rank">${rank}</td>
              <td>${renderTeamCell(t.team_id)}</td>
              <td>${t.mp}</td>
              <td>${t.w}</td>
              <td>${t.d}</td>
              <td>${t.l}</td>
              <td>${t.gf}</td>
              <td>${t.ga}</td>
              <td class="${gdClass}">${gd > 0 ? '+' : ''}${t.gd}</td>
              <td class="pts">${t.pts}</td>
            </tr>`;
        })
        .join('');

      return `
        <div class="group-card">
          <div class="group-header"><h3>Group ${group.name}</h3></div>
          <table class="standings-table">
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
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join('');
}

function renderMatchCard(game) {
  const status = getMatchStatus(game);
  const isLive = status.class === 'live';
  const homeTeam = teamsMap[game.home_team_id];
  const awayTeam = teamsMap[game.away_team_id];
  const homeFlag = homeTeam?.flag || '';
  const awayFlag = awayTeam?.flag || '';
  const homeName = game.home_team_name_en || homeTeam?.name_en || 'TBD';
  const awayName = game.away_team_name_en || awayTeam?.name_en || 'TBD';
  const homeScore = game.home_score ?? '-';
  const awayScore = game.away_score ?? '-';
  const showScore = game.finished === 'TRUE' || isLive;

  return `
    <div class="match-card ${isLive ? 'live' : status.class === 'upcoming' ? 'upcoming' : ''}">
      <div class="match-meta">
        <span class="match-stage">${getStageLabel(game)}</span>
        <span class="match-status ${status.class}">${status.label}</span>
      </div>
      <div class="match-teams">
        <div class="team">
          ${homeFlag ? `<img src="${homeFlag}" alt="" loading="lazy">` : ''}
          <span class="team-name">${homeName}</span>
        </div>
        <div class="score-block">
          <div class="score">
            ${showScore ? `${homeScore}<span class="score-sep"> – </span>${awayScore}` : 'vs'}
          </div>
          <span class="match-time">${formatMatchTime(game.local_date)}</span>
        </div>
        <div class="team">
          ${awayFlag ? `<img src="${awayFlag}" alt="" loading="lazy">` : ''}
          <span class="team-name">${awayName}</span>
        </div>
      </div>
    </div>`;
}

function getRelevantMatches(games) {
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const threeDaysAhead = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  return games
    .filter((g) => {
      const date = parseGameDate(g.local_date);
      const live = isGameLive(g);
      const upcoming = isGameUpcoming(g);
      const recent =
        g.finished === 'TRUE' && date >= threeDaysAgo && date <= now;
      const soon = upcoming && date <= threeDaysAhead;
      return live || soon || (recent && date >= threeDaysAgo);
    })
    .sort((a, b) => {
      const aLive = isGameLive(a) ? 0 : 1;
      const bLive = isGameLive(b) ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return parseGameDate(a.local_date) - parseGameDate(b.local_date);
    })
    .slice(0, 12);
}

function renderMatches(games) {
  const relevant = getRelevantMatches(games);
  hasLiveMatches = games.some(isGameLive);

  const liveSection = $('#live-section');
  const matchesGrid = $('#matches-grid');
  const liveIndicator = $('#live-indicator');

  if (relevant.length === 0) {
    liveSection.hidden = true;
    liveIndicator.hidden = true;
    return;
  }

  liveSection.hidden = false;
  liveIndicator.hidden = !hasLiveMatches;
  matchesGrid.innerHTML = relevant.map(renderMatchCard).join('');
}

function showError(message) {
  $('#groups-grid').innerHTML = `
    <div class="error-state">
      <p>${message}</p>
      <button onclick="loadData()">Try Again</button>
    </div>`;
}

function updateLastUpdated() {
  const el = $('#last-updated');
  el.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const interval = hasLiveMatches ? LIVE_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
  refreshTimer = setInterval(loadData, interval);
}

async function loadData() {
  const btn = $('#refresh-btn');
  btn.classList.add('spinning');

  try {
    const [teamsData, groupsData, gamesData] = await Promise.all([
      fetchJSON('teams'),
      fetchJSON('groups'),
      fetchJSON('games'),
    ]);

    teamsMap = Object.fromEntries(
      teamsData.teams.map((t) => [t.id, t])
    );

    $('#loading-state')?.remove();
    $('#groups-grid').innerHTML = renderStandings(groupsData.groups);
    renderMatches(gamesData.games);
    updateLastUpdated();
    scheduleRefresh();
  } catch (err) {
    console.error(err);
    if (!$('.group-card')) {
      showError('Could not load standings. Check your connection and try again.');
    }
  } finally {
    btn.classList.remove('spinning');
  }
}

$('#refresh-btn').addEventListener('click', loadData);
loadData();