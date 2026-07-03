const API_BASE = 'https://worldcup26.ir/get';
const DATA_BASE = 'data';
const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
const FIELD_LENGTH_M = 105;
const FIELD_WIDTH_M = 68;
const GROUP_ORDER = 'ABCDEFGHIJKL'.split('');

const POLL = { LIVE: 5_000, WINDOW: 8_000, SOON: 12_000, IDLE: 30_000 };

const LIVE_ELAPSED = new Set([
  'live', 'inplay', 'playing', '1sthalf', '2ndhalf', 'extratime', 'extra', 'penalties',
]);

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
  hasKickoffWindow: false,
  espnGoals: {},
  espnEventIds: {},
  espnKickoffs: {},
  gameOdds: {},
  gameBroadcasts: {},
  youtubeLive: null,
  goalClips: null,
  userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lastFetch: null,
  pollTimer: null,
  tickTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── API ──────────────────────────────────────────────────────────
// worldcup26.ir sets Cross-Origin-Resource-Policy: same-origin, so browsers
// block direct fetches from GitHub Pages. Same-origin JSON in data/ is synced
// by GitHub Actions; live API is kept as a dev fallback.

async function fetchJSON(endpoint) {
  const errors = [];

  try {
    const cached = await fetch(`${DATA_BASE}/${endpoint}.json`, { cache: 'no-store' });
    if (cached.ok) return cached.json();
    errors.push(`cache HTTP ${cached.status}`);
  } catch (err) {
    errors.push(`cache ${err.message}`);
  }

  try {
    const live = await fetch(`${API_BASE}/${endpoint}`);
    if (live.ok) return live.json();
    errors.push(`api HTTP ${live.status}`);
  } catch (err) {
    errors.push(`api ${err.message}`);
  }

  throw new Error(`Failed to fetch ${endpoint} (${errors.join('; ')})`);
}

async function fetchYoutubeLiveCache() {
  try {
    const res = await fetch(`${DATA_BASE}/youtube-live.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchGoalClipsCache() {
  try {
    const res = await fetch(`${DATA_BASE}/goal-clips.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Date / time ──────────────────────────────────────────────────
// API local_date is stadium-local kickoff, not the user's timezone.

const STADIUM_TIMEZONES = {
  1: 'America/Mexico_City',
  2: 'America/Mexico_City',
  3: 'America/Monterrey',
  4: 'America/Chicago',
  5: 'America/Chicago',
  6: 'America/Chicago',
  7: 'America/New_York',
  8: 'America/New_York',
  9: 'America/New_York',
  10: 'America/New_York',
  11: 'America/New_York',
  12: 'America/Toronto',
  13: 'America/Vancouver',
  14: 'America/Los_Angeles',
  15: 'America/Los_Angeles',
  16: 'America/Los_Angeles',
};

function getStadiumTimezone(stadiumId) {
  return STADIUM_TIMEZONES[String(stadiumId)] || 'America/New_York';
}

function getTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
  };
}

function compareDateParts(target, actual) {
  if (actual.year !== target.year) return actual.year - target.year;
  if (actual.month !== target.month) return actual.month - target.month;
  if (actual.day !== target.day) return actual.day - target.day;
  if (actual.hour !== target.hour) return actual.hour - target.hour;
  return actual.minute - target.minute;
}

function parseInTimeZone(dateStr, timeZone) {
  const [datePart, timePart] = dateStr.split(' ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute] = (timePart || '00:00').split(':').map(Number);
  const target = { year, month, day, hour, minute };
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let low = guess - 26 * 3_600_000;
  let high = guess + 26 * 3_600_000;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cmp = compareDateParts(target, getTimeParts(new Date(mid), timeZone));
    if (cmp === 0) return new Date(mid);
    if (cmp < 0) low = mid + 60_000;
    else high = mid - 60_000;
  }
  return new Date(guess);
}

function parseGameKickoff(game) {
  if (!game) return new Date();
  if (state.espnKickoffs[game.id]) return state.espnKickoffs[game.id];
  if (!game.local_date) return new Date();
  return parseInTimeZone(game.local_date, getStadiumTimezone(game.stadium_id));
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isKickoffToday(game) {
  return isSameCalendarDay(parseGameKickoff(game), new Date());
}

function formatKickoff(date) {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function formatStadiumKickoff(game) {
  const kickoff = parseGameKickoff(game);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: getStadiumTimezone(game.stadium_id),
  }).format(kickoff);
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone: getStadiumTimezone(game.stadium_id),
    timeZoneName: 'short',
  }).formatToParts(kickoff).find((p) => p.type === 'timeZoneName')?.value || '';
  return `${time} ${zone}`;
}

function kickoffLabelsDiffer(game) {
  const kickoff = parseGameKickoff(game);
  const user = getTimeParts(kickoff, state.userTimezone);
  const venue = getTimeParts(kickoff, getStadiumTimezone(game.stadium_id));
  return user.hour !== venue.hour || user.minute !== venue.minute
    || user.day !== venue.day || user.month !== venue.month;
}

function formatKickoffDisplay(game) {
  const kickoff = parseGameKickoff(game);
  const userLabel = formatKickoff(kickoff);
  if (!kickoffLabelsDiffer(game)) return userLabel;
  return `${userLabel} <span class="se-kick-venue">(${formatStadiumKickoff(game)} at venue)</span>`;
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

function minutesSinceKickoff(game) {
  return Math.floor((Date.now() - parseGameKickoff(game).getTime()) / 60_000);
}

function isWithinMatchWindow(game) {
  const mins = minutesSinceKickoff(game);
  return mins >= 0 && mins <= 150;
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

function hasMeaningfulScore(game) {
  if (!scoresArePlayable(game)) return false;
  const h = Number(game.home_score);
  const a = Number(game.away_score);
  return !isNaN(h) && !isNaN(a) && (h > 0 || a > 0);
}

function elapsedSignalsLive(e) {
  if (!e || e === 'notstarted' || e === 'finished') return false;
  if (e === 'ht' || e === 'halftime') return true;
  if (LIVE_ELAPSED.has(e)) return true;
  return /\d/.test(e);
}

function isApiLaggingLive(game) {
  if (game.finished === 'TRUE' || !isWithinMatchWindow(game)) return false;
  if (!isNotStarted(game)) return false;
  const mins = minutesSinceKickoff(game);
  if (mins < 5) return false;
  return hasMeaningfulScore(game) || mins >= 12;
}

function shouldShowScore(game) {
  if (isDefinitelyFinished(game)) return scoresArePlayable(game);
  if (isGameLive(game)) return scoresArePlayable(game);
  if (isNotStarted(game)) return false;
  return scoresArePlayable(game);
}

function isGameLive(game) {
  if (isDefinitelyFinished(game)) return false;
  if (isPrematureFinish(game)) return true;
  if (game.finished === 'TRUE') return false;
  const e = normalizeElapsed(game.time_elapsed);
  if (e === 'finished') return false;
  if (elapsedSignalsLive(e)) return true;
  return isApiLaggingLive(game);
}

function isGameInKickoffWindow(game) {
  if (game.finished === 'TRUE') return false;
  const diff = parseGameKickoff(game) - Date.now();
  return diff <= 30 * 60 * 1000 && diff >= -2.5 * 60 * 60 * 1000;
}

function isGameSoon(game) {
  if (game.finished === 'TRUE' || isGameLive(game)) return false;
  const diff = parseGameKickoff(game) - Date.now();
  return diff > 0 && diff <= 2 * 60 * 60 * 1000;
}

function estimateMinute(game) {
  const mins = minutesSinceKickoff(game);
  if (mins < 0) return null;
  if (mins <= 45) return `${mins}'`;
  if (mins <= 60) return 'HT';
  if (mins <= 105) return `${mins - 15}'`;
  if (mins <= 120) return `90+${mins - 105}'`;
  return '90+' ;
}

function getElapsedDisplay(game) {
  const e = normalizeElapsed(game.time_elapsed);
  if (game.finished === 'TRUE' || e === 'finished') return 'FT';
  if (e === 'ht' || e === 'halftime') return 'HT';
  const stoppage = e.match(/(\d+)\+(\d+)/);
  if (stoppage) return `${stoppage[1]}+${stoppage[2]}'`;
  const minute = e.match(/(\d+)/);
  if (minute) return `${minute[1]}'`;
  if (isGameLive(game)) return estimateMinute(game) || 'LIVE';
  return null;
}

function getUpcomingStatus(game) {
  const diff = parseGameKickoff(game) - Date.now();
  if (diff > 60_000) return `Starts in ${formatCountdown(diff)}`;
  if (diff > 0) return `Kickoff in ${formatCountdown(diff)}`;
  if (isNotStarted(game)) {
    const mins = minutesSinceKickoff(game);
    if (mins >= 1 && mins < 12) return 'Awaiting kickoff';
    if (mins >= 12) return 'Match in progress';
  }
  return 'Starting soon';
}

function isDefinitelyFinished(game) {
  if (game.finished !== 'TRUE') return false;
  const e = normalizeElapsed(game.time_elapsed);
  if (e === 'finished') return true;
  return minutesSinceKickoff(game) > 150;
}

function isPrematureFinish(game) {
  if (game.finished !== 'TRUE') return false;
  const e = normalizeElapsed(game.time_elapsed);
  if (e === 'finished') return false;
  const mins = minutesSinceKickoff(game);
  return mins >= 0 && mins < 105;
}

function getMatchPhase(game) {
  if (isPrematureFinish(game) || isGameLive(game)) return 'live';
  if (isDefinitelyFinished(game)) return 'finished';
  if (game.finished === 'TRUE') return 'finished';
  return 'upcoming';
}

function parseScorerEntry(text) {
  const ownGoal = /\(OG\)/i.test(text);
  const penalty = /\(p\)|\(P\)/i.test(text);
  const minuteMatch = text.match(/(\d+(?:\+\d+)?)'/);
  const player = text
    .replace(/\s*\d+(?:\+\d+)?'.*/, '')
    .replace(/\s*\([^)]*\)/g, '')
    .trim();
  return {
    player,
    minute: minuteMatch ? minuteMatch[1] : '',
    side: null,
    type: ownGoal ? 'own_goal' : penalty ? 'penalty' : 'open_play',
    distance: ownGoal ? null : penalty ? '12 yds (11 m)' : null,
    assist: null,
    shotDetail: ownGoal ? 'Own goal' : penalty ? 'Penalty' : 'Goal',
  };
}

function parseScorers(raw, side) {
  if (!raw || raw === 'null') return [];
  const matches = String(raw).match(/"([^"]+)"/g);
  if (!matches) return [];
  return matches.map((entry) => ({ ...parseScorerEntry(entry.replace(/"/g, '')), side }));
}

function normalizeTeamKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatEspnDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function espnScoreboardDates(kickoff) {
  const dates = new Set([formatEspnDate(kickoff)]);
  const utcY = kickoff.getUTCFullYear();
  const utcM = String(kickoff.getUTCMonth() + 1).padStart(2, '0');
  const utcD = String(kickoff.getUTCDate()).padStart(2, '0');
  dates.add(`${utcY}${utcM}${utcD}`);
  return [...dates];
}

async function fetchEspnJSON(path) {
  const res = await fetch(`${ESPN_API}${path}`);
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  return res.json();
}

function matchGameToEspnEvent(game, events) {
  const home = normalizeTeamKey(game.home_team_name_en || teamName(game.home_team_id));
  const away = normalizeTeamKey(game.away_team_name_en || teamName(game.away_team_id));
  return (events || []).find((event) => {
    const comps = event.competitions?.[0]?.competitors || [];
    const espnHome = comps.find((c) => c.homeAway === 'home');
    const espnAway = comps.find((c) => c.homeAway === 'away');
    return normalizeTeamKey(espnHome?.team?.displayName) === home
      && normalizeTeamKey(espnAway?.team?.displayName) === away;
  });
}

function formatAmericanOdds(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  if (s.startsWith('+') || s.startsWith('-')) return s;
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  return n > 0 ? `+${n}` : String(n);
}

function pickOddsVal(obj) {
  return obj?.current?.odds ?? obj?.close?.odds ?? obj?.open?.odds ?? null;
}

function pickSpreadLine(obj) {
  return obj?.current?.line ?? obj?.close?.line ?? obj?.open?.line ?? null;
}

function parseTotalLine(line) {
  if (!line) return null;
  return String(line).replace(/^[ou]/i, '');
}

function parseEspnOdds(oddsArr) {
  const raw = oddsArr?.[0];
  if (!raw) return null;

  const ml = raw.moneyline || {};
  const spread = raw.pointSpread || {};
  const total = raw.total || {};

  const homeMl = formatAmericanOdds(pickOddsVal(ml.home));
  const awayMl = formatAmericanOdds(pickOddsVal(ml.away));
  const drawMl = formatAmericanOdds(pickOddsVal(ml.draw) ?? raw.drawOdds?.moneyLine);

  if (!homeMl && !awayMl && !drawMl) return null;

  return {
    provider: raw.provider?.displayName || raw.provider?.name || 'Sportsbook',
    summary: raw.details || '',
    moneyline: { home: homeMl, away: awayMl, draw: drawMl },
    spread: {
      homeLine: pickSpreadLine(spread.home),
      homeOdds: formatAmericanOdds(pickOddsVal(spread.home)),
      awayLine: pickSpreadLine(spread.away),
      awayOdds: formatAmericanOdds(pickOddsVal(spread.away)),
    },
    total: {
      line: raw.overUnder ?? parseTotalLine(total.over?.current?.line) ?? parseTotalLine(total.over?.close?.line),
      over: formatAmericanOdds(pickOddsVal(total.over)),
      under: formatAmericanOdds(pickOddsVal(total.under)),
    },
  };
}

function getGameOdds(gameId) {
  return state.gameOdds[gameId] || null;
}

function oddsFingerprint(odds) {
  return odds ? JSON.stringify(odds) : '';
}

function getOddsTone(val) {
  if (!val) return '';
  const s = String(val);
  if (s.startsWith('-')) return 'fav';
  if (s.startsWith('+')) return 'dog';
  return '';
}

function oddsLaymanTitle(val) {
  const n = Number(String(val).replace('+', ''));
  if (Number.isNaN(n)) return 'Betting odds';
  if (n < 0) return `Favorite — bet $${Math.abs(n)} to win $100`;
  return `Underdog — bet $100 to win $${n}`;
}

function renderMlOdds(game, side, phase) {
  if (phase !== 'live' && phase !== 'upcoming') return '';
  const odds = getGameOdds(game.id);
  if (!odds) return '';
  const val = side === 'home' ? odds.moneyline.home : odds.moneyline.away;
  if (!val) return '';
  const tone = getOddsTone(val);
  const liveCls = phase === 'live' ? ' live-line' : '';
  const attr = side === 'home' ? 'home-ml' : 'away-ml';
  return `<span class="se-ml ${side} ${tone}${liveCls}" data-${attr}="${game.id}" title="${escapeHtml(oddsLaymanTitle(val))}">${val}</span>`;
}

function renderDrawOdds(game, phase) {
  if (phase !== 'live' && phase !== 'upcoming') return '';
  const odds = getGameOdds(game.id);
  if (!odds?.moneyline.draw) return '';
  const val = odds.moneyline.draw;
  const tone = getOddsTone(val);
  const liveCls = phase === 'live' ? ' live-line' : '';
  return `
    <div class="se-draw-odds" data-draw-wrap="${game.id}">
      <span class="se-draw-lbl">DRAW</span>
      <span class="se-ml draw ${tone}${liveCls}" data-draw-ml="${game.id}" title="${escapeHtml(oddsLaymanTitle(val))}">${val}</span>
    </div>`;
}

function syncMlEl(card, game, side, val, phase) {
  const mlAttr = side === 'home' ? 'home-ml' : 'away-ml';
  const scoreAttr = side === 'home' ? 'home-score' : 'away-score';
  let el = card.querySelector(`[data-${mlAttr}="${game.id}"]`);

  if (!val) {
    el?.remove();
    return;
  }

  const tone = getOddsTone(val);
  const liveCls = phase === 'live' ? ' live-line' : '';
  const title = oddsLaymanTitle(val);

  if (!el) {
    const anchor = card.querySelector(`[data-${scoreAttr}="${game.id}"]`);
    anchor?.insertAdjacentHTML(
      'afterend',
      `<span class="se-ml ${side} ${tone}${liveCls}" data-${mlAttr}="${game.id}" title="${escapeHtml(title)}">${val}</span>`,
    );
    return;
  }

  if (el.textContent !== val) el.textContent = val;
  el.className = `se-ml ${side} ${tone}${liveCls}`;
  el.title = title;
}

function syncDrawEl(card, game, val, phase) {
  let wrap = card.querySelector(`[data-draw-wrap="${game.id}"]`);

  if (!val) {
    wrap?.remove();
    return;
  }

  const tone = getOddsTone(val);
  const liveCls = phase === 'live' ? ' live-line' : '';
  const title = oddsLaymanTitle(val);

  if (!wrap) {
    const mid = card.querySelector('.se-mid');
    const vs = mid?.querySelector('.se-vs');
    vs?.insertAdjacentHTML(
      'afterend',
      `<div class="se-draw-odds" data-draw-wrap="${game.id}">
        <span class="se-draw-lbl">DRAW</span>
        <span class="se-ml draw ${tone}${liveCls}" data-draw-ml="${game.id}" title="${escapeHtml(title)}">${val}</span>
      </div>`,
    );
    return;
  }

  const el = wrap.querySelector(`[data-draw-ml="${game.id}"]`);
  if (el) {
    if (el.textContent !== val) el.textContent = val;
    el.className = `se-ml draw ${tone}${liveCls}`;
    el.title = title;
  }
}

function syncScoreOdds(card, game, phase) {
  card.querySelector('.match-odds')?.remove();

  const show = phase === 'live' || phase === 'upcoming';
  const odds = getGameOdds(game.id);

  if (!show || !odds) {
    card.querySelector(`[data-home-ml="${game.id}"]`)?.remove();
    card.querySelector(`[data-away-ml="${game.id}"]`)?.remove();
    card.querySelector(`[data-draw-wrap="${game.id}"]`)?.remove();
    delete card.dataset.oddsFp;
    return;
  }

  const fp = oddsFingerprint(odds);
  if (card.dataset.oddsFp === fp) return;
  card.dataset.oddsFp = fp;

  syncMlEl(card, game, 'home', odds.moneyline.home, phase);
  syncMlEl(card, game, 'away', odds.moneyline.away, phase);
  syncDrawEl(card, game, odds.moneyline.draw, phase);
}

function renderBracketMl(game, side, phase) {
  if (phase === 'finished') return '';
  const odds = getGameOdds(game.id);
  if (!odds) return '';
  const val = side === 'home' ? odds.moneyline.home : odds.moneyline.away;
  if (!val) return '';
  const tone = getOddsTone(val);
  const liveCls = phase === 'live' ? ' live-line' : '';
  return `<span class="b-ml ${tone}${liveCls}" title="${escapeHtml(oddsLaymanTitle(val))}">${val}</span>`;
}

const WATCH_HUBS = {
  FOX: { label: 'FOX Sports', url: 'https://www.foxsports.com/soccer/fifa-world-cup' },
  FS1: { label: 'FS1', url: 'https://www.foxsports.com/soccer/fifa-world-cup' },
  'FOX One': { label: 'FOX One', url: 'https://www.fox.com/soccer/fifa-world-cup' },
  Tele: { label: 'Telemundo', url: 'https://www.telemundo.com/shows/futbol/world-cup' },
  Universo: { label: 'Universo', url: 'https://www.telemundo.com/shows/futbol/world-cup' },
};

const FREE_WATCH_OPTIONS = [
  { label: 'FIFA+', url: 'https://www.plus.fifa.com/en/', note: 'Select matches stream free on FIFA+' },
  { label: 'Tubi', url: 'https://tubitv.com/hubs/fifa-world-cup-fox-hub', note: 'Free FOX World Cup hub on Tubi' },
];

const YT_TEAM_ALIASES = {
  'united states': ['usa', 'u.s.', 'u.s.a.', 'america'],
  'south korea': ['korea republic', 'republic of korea', 'korea'],
  'ivory coast': ['cote d\'ivoire', 'côte d\'ivoire'],
  'czech republic': ['czechia'],
  'democratic republic of the congo': ['dr congo', 'congo dr', 'drc'],
  'bosnia and herzegovina': ['bosnia'],
};

function normalizeTeamToken(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function youtubeTeamMatches(gameName, youtubeName) {
  const game = normalizeTeamToken(gameName);
  const yt = normalizeTeamToken(youtubeName);
  if (!game || !yt) return false;
  if (game === yt || game.includes(yt) || yt.includes(game)) return true;
  const aliases = YT_TEAM_ALIASES[game] || [];
  return aliases.some((alias) => yt.includes(alias) || alias.includes(yt));
}

function getYoutubeEmbedForGame(game) {
  const live = state.youtubeLive?.foxSports;
  if (!live?.videoId || !live.isLive) return null;
  const teams = live.parsedTeams || [];
  if (teams.length < 2) return null;

  const home = game.home_team_name_en || teamName(game.home_team_id) || '';
  const away = game.away_team_name_en || teamName(game.away_team_id) || '';
  const direct = youtubeTeamMatches(home, teams[0]) && youtubeTeamMatches(away, teams[1]);
  const flipped = youtubeTeamMatches(home, teams[1]) && youtubeTeamMatches(away, teams[0]);
  if (!direct && !flipped) return null;

  return {
    videoId: live.videoId,
    title: live.title,
    source: 'FOX Sports',
  };
}

function parseEspnBroadcasts(espnEvent) {
  const geo = espnEvent?.competitions?.[0]?.geoBroadcasts || [];
  return [...new Set(geo.map((g) => g.media?.shortName).filter(Boolean))];
}

function getWatchOptions(game) {
  const broadcasts = state.gameBroadcasts[game.id] || [];
  const espnId = state.espnEventIds[game.id];
  const paid = [];

  broadcasts.forEach((name) => {
    const hub = WATCH_HUBS[name];
    if (hub) {
      paid.push({
        ...hub,
        primary: name === 'FOX' || name === 'FOX One',
      });
    }
  });

  if (espnId) {
    paid.push({
      label: 'ESPN Gamecast',
      url: `https://www.espn.com/soccer/match/_/gameId/${espnId}`,
      tracker: true,
    });
  }

  return { paid, free: FREE_WATCH_OPTIONS };
}

function watchPanelFingerprint(game, phase) {
  const embed = getYoutubeEmbedForGame(game);
  return JSON.stringify({ phase, embed, options: getWatchOptions(game) });
}

function renderWatchPlayer(embed) {
  if (!embed) return '';
  return `
    <div class="watch-player">
      <iframe
        src="https://www.youtube.com/embed/${embed.videoId}?autoplay=0&rel=0"
        title="${escapeHtml(embed.title)}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"></iframe>
    </div>`;
}

function renderWatchBar(game, phase) {
  if (phase !== 'live' && phase !== 'upcoming') return '';
  const opts = getWatchOptions(game);
  const embed = phase === 'live' ? getYoutubeEmbedForGame(game) : null;
  if (!embed && !opts.paid.length && !opts.free.length) return '';

  const paidBtns = opts.paid.map((o) => `
    <a class="watch-btn ${o.tracker ? 'tracker' : ''} ${o.primary ? 'primary' : ''}"
       href="${o.url}" target="_blank" rel="noopener noreferrer">
      ${o.tracker ? 'Live tracker · ' : ''}${escapeHtml(o.label)}
    </a>`).join('');

  const freeBtns = opts.free.map((o) => `
    <a class="watch-btn free" href="${o.url}" target="_blank" rel="noopener noreferrer"
       title="${escapeHtml(o.note)}">
      ${escapeHtml(o.label)} <span class="free-tag">FREE</span>
    </a>`).join('');

  const fp = watchPanelFingerprint(game, phase);
  const liveLabel = phase === 'live' ? 'Watch Live' : 'Where to Watch';
  const note = embed
    ? `Official ${escapeHtml(embed.source)} stream on YouTube`
    : 'Full broadcasts open on broadcaster sites';

  return `
    <div class="watch-bar" data-watch="${game.id}" data-watch-fp="${fp}">
      <div class="watch-bar-head">
        <span class="watch-title">▶ ${liveLabel}</span>
        <span class="watch-note">${note}</span>
      </div>
      ${renderWatchPlayer(embed)}
      <div class="watch-btns">${paidBtns}${freeBtns}</div>
    </div>`;
}

function syncWatchBar(card, game, phase) {
  const el = card.querySelector(`[data-watch="${game.id}"]`);
  if (phase !== 'live' && phase !== 'upcoming') {
    el?.remove();
    return;
  }

  const html = renderWatchBar(game, phase);
  if (!html) {
    el?.remove();
    return;
  }

  const fp = watchPanelFingerprint(game, phase);
  if (el?.dataset.watchFp === fp) return;

  if (!el) {
    card.querySelector('.se-card-top')?.insertAdjacentHTML('afterend', html);
    return;
  }
  el.outerHTML = html;
}

function renderBracketDrawMl(game, phase) {
  if (phase === 'finished') return '';
  const odds = getGameOdds(game.id);
  if (!odds?.moneyline.draw) return '';
  const val = odds.moneyline.draw;
  const tone = getOddsTone(val);
  const liveCls = phase === 'live' ? ' live-line' : '';
  return `<span class="b-draw-ml ${tone}${liveCls}" title="${escapeHtml(oddsLaymanTitle(val))}">DRAW ${val}</span>`;
}

function calcShotDistance(x, y) {
  const dx = ((100 - x) / 100) * FIELD_LENGTH_M;
  const dy = ((y - 50) / 100) * FIELD_WIDTH_M;
  return Math.sqrt(dx * dx + dy * dy);
}

function formatDistance(meters) {
  const yards = Math.round(meters * 1.09361);
  const m = Math.round(meters);
  return `${yards} yds (${m} m)`;
}

function parseDistanceFromText(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('six yard')) return '6 yds (5 m)';
  if (t.includes('centre of the box') || t.includes('center of the box')) return '12 yds (11 m)';
  if (t.includes('edge of the box')) return '18 yds (16 m)';
  if (t.includes('outside the box')) return '22 yds (20 m)';
  if (t.includes('penalty')) return '12 yds (11 m)';
  return null;
}

function parseAssistFromText(text) {
  const hit = (text || '').match(/assisted by ([^.]+?)(?: with|\.|$)/i);
  return hit ? hit[1].trim() : null;
}

function parseShotDetail(text, typeText) {
  const t = (text || '').toLowerCase();
  if (typeText?.toLowerCase().includes('header') || t.includes('header')) {
    const zone = t.match(/header from ([^.]+)/i);
    return zone ? `Header · ${zone[1].trim()}` : 'Header';
  }
  const shot = t.match(/(left|right) footed shot from ([^.]+)/i);
  if (shot) return `${shot[1][0].toUpperCase()}${shot[1].slice(1)} foot · ${shot[2].trim()}`;
  if (t.includes('penalty')) return 'Penalty';
  return typeText || 'Goal';
}

function parseEspnScoringPlay(play, espnHomeTeamId) {
  const participants = play.participants || [];
  const scorerPart = participants.find((p) => p.type !== 'assist') || participants[0];
  const assistPart = participants.find((p) => p.type === 'assist');
  const side = String(play.team?.id) === String(espnHomeTeamId) ? 'home' : 'away';
  const distance = play.fieldPositionX != null && play.fieldPositionY != null
    ? formatDistance(calcShotDistance(play.fieldPositionX, play.fieldPositionY))
    : parseDistanceFromText(play.text);
  return {
    player: scorerPart?.athlete?.displayName || 'Unknown',
    minute: (play.clock?.displayValue || '').replace(/'/g, ''),
    side,
    type: play.type?.text?.toLowerCase().includes('header') ? 'header'
      : play.type?.text?.toLowerCase().includes('penalty') ? 'penalty' : 'open_play',
    distance,
    assist: assistPart?.athlete?.displayName || parseAssistFromText(play.text),
    shotDetail: parseShotDetail(play.text, play.type?.text),
  };
}

async function fetchEspnGoalsForGame(gameId, espnEventId) {
  const summary = await fetchEspnJSON(`/summary?event=${espnEventId}`);
  const homeTeamId = summary.header?.competitions?.[0]?.competitors
    ?.find((c) => c.homeAway === 'home')?.id;
  state.espnGoals[gameId] = (summary.keyEvents || [])
    .filter((e) => e.scoringPlay)
    .map((e) => parseEspnScoringPlay(e, homeTeamId));
}

async function enrichGamesWithEspn() {
  const oddsTargets = state.games.filter((g) => {
    const phase = getMatchPhase(g);
    return phase === 'live' || phase === 'upcoming';
  });
  const goalTargets = state.games.filter((g) => isGameLive(g) || isKickoffToday(g));
  const targets = [...new Set([...oddsTargets, ...goalTargets].map((g) => g.id))]
    .map((id) => state.games.find((g) => String(g.id) === String(id)))
    .filter(Boolean);

  if (!targets.length) return;

  const dates = [...new Set(targets.flatMap((g) => espnScoreboardDates(parseGameKickoff(g))))];
  const boards = await Promise.all(
    dates.map((d) => fetchEspnJSON(`/scoreboard?dates=${d}`).catch(() => ({ events: [] }))),
  );
  const allEvents = boards.flatMap((b) => b.events || []);

  await Promise.all(targets.map(async (game) => {
    const espnEvent = matchGameToEspnEvent(game, allEvents);
    if (!espnEvent) return;
    state.espnEventIds[game.id] = espnEvent.id;
    if (espnEvent.date) state.espnKickoffs[game.id] = new Date(espnEvent.date);

    const parsedOdds = parseEspnOdds(espnEvent.competitions?.[0]?.odds);
    if (parsedOdds) {
      state.gameOdds[game.id] = parsedOdds;
    }

    const broadcasts = parseEspnBroadcasts(espnEvent);
    if (broadcasts.length) {
      state.gameBroadcasts[game.id] = broadcasts;
    }

    if (!isGameLive(game) && !isKickoffToday(game)) return;

    try {
      const prev = state.espnGoals[game.id];
      await fetchEspnGoalsForGame(game.id, espnEvent.id);
      if (!state.espnGoals[game.id]?.length && prev?.length) {
        state.espnGoals[game.id] = prev;
      }
    } catch {
      /* ESPN enrichment is best-effort — keep any goals we already have */
    }
  }));
}

function getGameGoals(game) {
  const espn = state.espnGoals[game.id];
  if (espn?.length) return espn;
  const goals = [
    ...parseScorers(game.home_scorers, 'home'),
    ...parseScorers(game.away_scorers, 'away'),
  ];
  return goals.sort((a, b) => {
    const ma = parseInt(String(a.minute).split('+')[0], 10) || 0;
    const mb = parseInt(String(b.minute).split('+')[0], 10) || 0;
    return ma - mb;
  });
}

function getMatchMinuteNumber(game) {
  const elapsed = getElapsedDisplay(game);
  if (!elapsed || elapsed === 'LIVE') {
    const est = estimateMinute(game);
    if (est === 'HT') return 45;
    const m = parseInt(est, 10);
    return Number.isNaN(m) ? 0 : m;
  }
  if (elapsed === 'HT') return 45;
  if (elapsed === '90+') return 90;
  const stoppage = elapsed.match(/(\d+)\+(\d+)/);
  if (stoppage) return parseInt(stoppage[1], 10) + parseInt(stoppage[2], 10);
  const m = parseInt(elapsed, 10);
  return Number.isNaN(m) ? 0 : m;
}

function getMatchPeriod(game) {
  const e = normalizeElapsed(game.time_elapsed);
  if (e === 'ht' || e === 'halftime') return 'Half Time';
  if (e === 'extratime' || e === 'extra') return 'Extra Time';
  if (e === 'penalties') return 'Penalties';
  if (getElapsedDisplay(game) === 'HT') return 'Half Time';
  const mins = minutesSinceKickoff(game);
  if (mins <= 45) return '1st Half';
  if (mins <= 60) return 'Half Time';
  return '2nd Half';
}

function getProgressPercent(game) {
  if (getMatchPeriod(game) === 'Half Time') return 50;
  const min = getMatchMinuteNumber(game);
  return Math.min(Math.round((min / 90) * 100), 100);
}

function goalClipKey(goal) {
  return `${goal.side}|${goal.minute}|${goal.player}`;
}

function getGoalClip(gameId, goal) {
  return state.goalClips?.games?.[gameId]?.goals?.[goalClipKey(goal)] || null;
}

function goalsFingerprint(goals, gameId) {
  return (goals || []).map((g) => {
    const clip = gameId ? getGoalClip(gameId, g) : null;
    const clipRef = clip?.videoId || clip?.webUrl || '';
    return [
      g.side, g.minute, g.player, g.type, g.assist || '', g.distance || '', g.shotDetail || '', clipRef,
    ].join('|');
  }).join(';');
}

function goalBadgeLabel(type) {
  if (type === 'penalty') return 'PEN';
  if (type === 'own_goal') return 'OG';
  if (type === 'header') return 'HDR';
  return 'GOAL';
}

function renderGoalClip(gameId, goal) {
  const clip = getGoalClip(gameId, goal);
  if (!clip) return '';

  if (clip.videoId) {
    const thumb = clip.thumb || `https://i.ytimg.com/vi/${clip.videoId}/hqdefault.jpg`;
    return `
      <div class="ge-clip">
        <button type="button" class="ge-clip-btn" data-yt="${clip.videoId}"
                title="${escapeHtml(clip.title || 'Watch goal clip')}" aria-label="Play goal clip">
          <img class="ge-clip-thumb" src="${thumb}" alt="" loading="lazy">
          <span class="ge-clip-play">▶</span>
        </button>
      </div>`;
  }

  if (clip.webUrl) {
    return `
      <a class="ge-clip-link" href="${clip.webUrl}" target="_blank" rel="noopener noreferrer"
         title="${escapeHtml(clip.title || 'Watch clip')}">
        <span class="ge-clip-play">▶</span> Clip
      </a>`;
  }

  return '';
}

function renderGoalEventRow(g, gameId) {
  const clip = renderGoalClip(gameId, g);
  return `
    <div class="goal-event ${g.side}">
      <span class="ge-min">${g.minute}'</span>
      <div class="ge-body">
        <span class="ge-scorer">${escapeHtml(g.player)}</span>
        <span class="ge-detail">${escapeHtml(g.shotDetail)}${g.distance ? ` · <strong>${g.distance}</strong>` : ''}</span>
        ${g.assist ? `<span class="ge-assist">Assist: ${escapeHtml(g.assist)}</span>` : ''}
      </div>
      <div class="ge-meta">
        ${clip}
        <span class="ge-badge ${g.type}">${goalBadgeLabel(g.type)}</span>
      </div>
    </div>`;
}

function animateNewGoalRow(row) {
  if (!row) return;
  row.classList.add('goal-event-new');
  row.addEventListener('animationend', () => row.classList.remove('goal-event-new'), { once: true });
}

function syncGoalEvents(card, game, live = false) {
  const goals = getGameGoals(game);
  const fp = goalsFingerprint(goals, game.id);
  let el = card.querySelector(`[data-goals="${game.id}"]`);

  if (!goals.length) {
    el?.remove();
    return;
  }

  if (el?.dataset.goalsFp === fp) return;

  const prevCount = Number(el?.dataset.goalsCount || 0);
  const canAppend = el
    && goals.length > prevCount
    && goalsFingerprint(goals.slice(0, prevCount), game.id) === el.dataset.goalsFp;

  if (!el) {
    card.querySelector('.se-foot')?.insertAdjacentHTML('beforebegin', renderGoalEvents(game, live));
    el = card.querySelector(`[data-goals="${game.id}"]`);
    if (!el) return;
    el.dataset.goalsFp = fp;
    el.dataset.goalsCount = String(goals.length);
    animateNewGoalRow(el.querySelector('.goal-event:last-child'));
    return;
  }

  if (canAppend) {
    for (let i = prevCount; i < goals.length; i += 1) {
      el.insertAdjacentHTML('beforeend', renderGoalEventRow(goals[i], game.id));
      animateNewGoalRow(el.querySelector('.goal-event:last-child'));
    }
    const countEl = el.querySelector('.goal-count');
    if (countEl) countEl.textContent = goals.length;
    el.dataset.goalsFp = fp;
    el.dataset.goalsCount = String(goals.length);
    return;
  }

  el.querySelectorAll('.goal-event').forEach((row) => row.remove());
  el.insertAdjacentHTML('beforeend', goals.map((g) => renderGoalEventRow(g, game.id)).join(''));
  const countEl = el.querySelector('.goal-count');
  if (countEl) countEl.textContent = goals.length;
  el.dataset.goalsFp = fp;
  el.dataset.goalsCount = String(goals.length);
}

function renderGoalEvents(game, live = false) {
  const goals = getGameGoals(game);
  if (!goals.length) return '';
  const cls = live ? 'goal-events live-goals' : 'goal-events';
  const fp = goalsFingerprint(goals, game.id);
  return `
    <div class="${cls}" data-goals="${game.id}" data-goals-fp="${fp}" data-goals-count="${goals.length}">
      <div class="goal-events-head">
        <span>Goal Events</span>
        <span class="goal-count">${goals.length}</span>
      </div>
      ${goals.map((g) => renderGoalEventRow(g, game.id)).join('')}
    </div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLiveTracker(game) {
  const period = getMatchPeriod(game);
  const minute = getElapsedDisplay(game) || 'LIVE';
  const pct = getProgressPercent(game);
  return `
    <div class="se-tracker" data-tracker="${game.id}">
      <div class="se-track-top">
        <span class="se-period" data-live-period="${game.id}">${period}</span>
        <span class="se-match-clock" data-live-minute="${game.id}">${minute}</span>
      </div>
      <div class="se-progress">
        <div class="se-progress-fill" data-live-progress="${game.id}" style="width:${pct}%"></div>
        <span class="se-progress-ht" aria-hidden="true"></span>
      </div>
    </div>`;
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
    .sort((a, b) => parseGameKickoff(a) - parseGameKickoff(b))
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
  const homeId = game.home_team_id;
  const awayId = game.away_team_id;
  const homeName = game.home_team_name_en || teamName(homeId) || 'TBD';
  const awayName = game.away_team_name_en || teamName(awayId) || 'TBD';

  let footText = '';
  let statusBadge = '';
  if (phase === 'live') {
    footText = elapsed ? `LIVE · ${elapsed}` : 'LIVE';
    statusBadge = '<span class="se-live-tag">LIVE</span>';
  } else if (phase === 'upcoming') {
    footText = getUpcomingStatus(game);
  } else {
    footText = 'Full Time';
    statusBadge = '<span class="se-ft-tag">FT</span>';
  }

  const pensHtml = score?.pens
    ? `<span class="se-pens">(${score.pens.home}-${score.pens.away} pens)</span>` : '';
  const trackerHtml = phase === 'live' ? renderLiveTracker(game) : '';
  const goalsHtml = renderGoalEvents(game, phase === 'live');

  return `
    <article class="se-card ${phase}" data-game-id="${game.id}">
      <div class="se-card-bar"></div>
      <div class="se-card-top">
        <span class="se-league">${getStageLabel(game)}</span>
        ${statusBadge}
        <span class="se-kick">${formatKickoffDisplay(game)}</span>
      </div>
      ${renderWatchBar(game, phase)}
      ${trackerHtml}
      <div class="se-body">
        <div class="se-side ${phase === 'live' ? 'live-side' : ''}">
          ${flagImg(homeId)}
          <span class="se-team">${homeName}</span>
          <div class="se-score-stack">
            <span class="se-score" data-home-score="${game.id}">${score ? score.home : ''}</span>
            ${renderMlOdds(game, 'home', phase)}
          </div>
        </div>
        <div class="se-mid">
          <span class="se-vs">${score ? '-' : 'vs'}</span>
          ${renderDrawOdds(game, phase)}
          ${pensHtml}
        </div>
        <div class="se-side ${phase === 'live' ? 'live-side' : ''}">
          ${flagImg(awayId)}
          <span class="se-team">${awayName}</span>
          <div class="se-score-stack">
            <span class="se-score" data-away-score="${game.id}">${score ? score.away : ''}</span>
            ${renderMlOdds(game, 'away', phase)}
          </div>
        </div>
      </div>
      ${goalsHtml}
      <div class="se-foot ${phase === 'live' ? 'live-text' : ''}" data-countdown="${game.id}">${footText}</div>
    </article>`;
}

function patchStreamCard(card, game) {
  const phase = getMatchPhase(game);
  const score = getScore(game);
  const elapsed = getElapsedDisplay(game);

  card.className = `se-card ${phase}`;

  const top = card.querySelector('.se-card-top');
  if (top) {
    if (phase === 'live') {
      top.querySelector('.se-ft-tag')?.remove();
      if (!top.querySelector('.se-live-tag')) {
        top.insertAdjacentHTML('beforeend', '<span class="se-live-tag">LIVE</span>');
      }
    } else if (phase === 'finished') {
      top.querySelector('.se-live-tag')?.remove();
      if (!top.querySelector('.se-ft-tag')) {
        top.insertAdjacentHTML('beforeend', '<span class="se-ft-tag">FT</span>');
      }
    } else {
      top.querySelector('.se-live-tag')?.remove();
      top.querySelector('.se-ft-tag')?.remove();
    }
  }

  const tracker = card.querySelector(`[data-tracker="${game.id}"]`);
  if (phase === 'live') {
    if (!tracker) {
      card.querySelector('.se-card-top')?.insertAdjacentHTML('afterend', renderLiveTracker(game));
    } else {
      const periodEl = card.querySelector(`[data-live-period="${game.id}"]`);
      const minuteEl = card.querySelector(`[data-live-minute="${game.id}"]`);
      const progressEl = card.querySelector(`[data-live-progress="${game.id}"]`);
      if (periodEl) periodEl.textContent = getMatchPeriod(game);
      if (minuteEl) minuteEl.textContent = elapsed || 'LIVE';
      if (progressEl) progressEl.style.width = `${getProgressPercent(game)}%`;
    }
  } else {
    tracker?.remove();
  }

  const homeScore = card.querySelector(`[data-home-score="${game.id}"]`);
  const awayScore = card.querySelector(`[data-away-score="${game.id}"]`);
  const vs = card.querySelector('.se-vs');
  if (score) {
    if (homeScore) homeScore.textContent = score.home;
    if (awayScore) awayScore.textContent = score.away;
    if (vs) vs.textContent = '-';
  } else {
    if (homeScore) homeScore.textContent = '';
    if (awayScore) awayScore.textContent = '';
    if (vs) vs.textContent = 'vs';
  }

  card.querySelectorAll('.se-side').forEach((side) => {
    side.classList.toggle('live-side', phase === 'live');
  });

  const foot = card.querySelector(`[data-countdown="${game.id}"]`);
  if (foot) {
    if (phase === 'live') {
      foot.textContent = elapsed ? `LIVE · ${elapsed}` : 'LIVE';
      foot.className = 'se-foot live-text';
    } else if (phase === 'upcoming') {
      foot.textContent = getUpcomingStatus(game);
      foot.className = 'se-foot';
    } else {
      foot.textContent = 'Full Time';
      foot.className = 'se-foot';
    }
  }

  syncWatchBar(card, game, phase);
  syncGoalEvents(card, game, phase === 'live');
  syncScoreOdds(card, game, phase);
}

function renderToday() {
  const todayGames = state.games
    .filter((g) => isKickoffToday(g))
    .sort((a, b) => parseGameKickoff(a) - parseGameKickoff(b));

  const meta = $('#today-meta');
  if (meta) {
    const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value || '';
    meta.textContent = todayGames.length
      ? `${todayGames.length} match${todayGames.length !== 1 ? 'es' : ''} today · times in your timezone (${tz})`
      : 'No matches today';
  }

  const container = $('#today-timeline');
  $('#today-loading')?.remove();

  if (!todayGames.length) {
    container.innerHTML = '<p class="empty-msg">No matches scheduled for today.</p>';
    return;
  }

  const nextIds = new Set(todayGames.map((g) => String(g.id)));
  container.querySelectorAll('.se-card[data-game-id]').forEach((card) => {
    if (!nextIds.has(card.dataset.gameId)) card.remove();
  });

  todayGames.forEach((game) => {
    const id = String(game.id);
    let card = container.querySelector(`.se-card[data-game-id="${id}"]`);
    if (card) {
      patchStreamCard(card, game);
    } else {
      container.insertAdjacentHTML('beforeend', renderStreamCard(game));
    }
  });
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
      ${renderBracketMl(game, side, phase)}
      ${scoreVal !== '' ? `<span class="b-score">${scoreVal}</span>` : ''}
    </div>`;
}

function renderBracketMatch(game) {
  const phase = getMatchPhase(game);
  const winnerSide = getMatchWinnerSide(game);
  return `
    <div class="b-match ${phase}" data-game-id="${game.id}">
      <div class="b-match-id">
        <span>${getStageLabel(game)} #${game.id}</span>
        ${renderBracketDrawMl(game, phase)}
      </div>
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
    const phase = r.phase;
    const statusText = phase === 'live' ? 'LIVE NOW' : `Next: ${formatKickoffDisplay(r.match)}`;
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
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    });
  }

  let liveNow = false;

  $$('[data-countdown]').forEach((el) => {
    const game = state.games.find((g) => String(g.id) === String(el.dataset.countdown));
    if (!game) return;
    const phase = getMatchPhase(game);
    const card = el.closest('.se-card, .b-match');

    if (phase === 'upcoming') {
      el.textContent = getUpcomingStatus(game);
      el.className = 'se-foot';
      card?.classList.remove('live', 'finished');
      card?.classList.add('upcoming');
    } else if (phase === 'live') {
      liveNow = true;
      const elapsed = getElapsedDisplay(game);
      el.textContent = elapsed ? `LIVE · ${elapsed}` : 'LIVE';
      el.className = 'se-foot live-text';
      card?.classList.add('live');
      card?.classList.remove('finished', 'upcoming');
      updateLiveCard(card, game, elapsed);
    } else if (phase === 'finished') {
      el.textContent = 'Full Time';
      el.className = 'se-foot';
      card?.classList.remove('live', 'upcoming');
      card?.classList.add('finished');
      card?.querySelector('.se-live-tag')?.remove();
    }
  });

  if (liveNow || state.hasLive) {
    renderLiveBanner();
    renderHeaderStats();
  }
}

function updateLiveCard(card, game, elapsed) {
  if (!card?.classList.contains('se-card')) return;

  const periodEl = card.querySelector(`[data-live-period="${game.id}"]`);
  const minuteEl = card.querySelector(`[data-live-minute="${game.id}"]`);
  const progressEl = card.querySelector(`[data-live-progress="${game.id}"]`);
  if (periodEl) periodEl.textContent = getMatchPeriod(game);
  if (minuteEl) minuteEl.textContent = elapsed || 'LIVE';
  if (progressEl) progressEl.style.width = `${getProgressPercent(game)}%`;

  const score = getScore(game);
  const homeScore = card.querySelector(`[data-home-score="${game.id}"]`);
  const awayScore = card.querySelector(`[data-away-score="${game.id}"]`);
  const vs = card.querySelector('.se-vs');
  if (score) {
    if (homeScore) homeScore.textContent = score.home;
    if (awayScore) awayScore.textContent = score.away;
    if (vs) vs.textContent = '-';
  }

  if (!card.querySelector('.se-live-tag')) {
    card.querySelector('.se-ft-tag')?.remove();
    card.querySelector('.se-card-top')?.insertAdjacentHTML(
      'beforeend',
      '<span class="se-live-tag">LIVE</span>',
    );
  }

  if (!card.querySelector(`[data-tracker="${game.id}"]`)) {
    card.querySelector('.se-card-top')?.insertAdjacentHTML('afterend', renderLiveTracker(game));
  }
}

// ── Polling & load ───────────────────────────────────────────────

function getPollInterval() {
  if (state.hasLive) return POLL.LIVE;
  if (state.hasKickoffWindow) return POLL.WINDOW;
  if (state.hasSoon) return POLL.SOON;
  return POLL.IDLE;
}

function schedulePoll() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(loadData, getPollInterval());
}

function updateLiveFlags() {
  state.hasLive = state.games.some(isGameLive);
  state.hasKickoffWindow = state.games.some(isGameInKickoffWindow);
  state.hasSoon = state.games.some(isGameSoon);
}

function showLoadError(err) {
  const message = err?.message || 'Could not load match data';
  const html = `<p class="empty-msg error-msg">${escapeHtml(message)} <button type="button" class="retry-btn" onclick="loadData()">Retry</button></p>`;
  $('#today-loading')?.remove();
  if ($('#today-timeline') && !state.games.length) $('#today-timeline').innerHTML = html;
  if ($('#bracket-board') && !state.games.length) $('#bracket-board').innerHTML = html;
  $('#standings-loading')?.remove();
  if ($('#standings-layout') && !state.groups.length) $('#standings-layout').innerHTML = html;
}

async function loadData() {
  const btn = $('#refresh-btn');
  btn?.classList.add('spinning');
  try {
    const [teamsData, groupsData, gamesData, youtubeLive, goalClips] = await Promise.all([
      fetchJSON('teams'), fetchJSON('groups'), fetchJSON('games'),
      fetchYoutubeLiveCache(), fetchGoalClipsCache(),
    ]);
    state.teamsMap = Object.fromEntries(teamsData.teams.map((t) => [t.id, t]));
    state.groups = groupsData.groups;
    state.games = gamesData.games;
    state.youtubeLive = youtubeLive;
    state.goalClips = goalClips;
    state.lastFetch = Date.now();
    state.thirdPlaceRankings = computeThirdPlaceRankings(state.groups);
    state.teamStatusMap = buildTeamStatusMap(state.groups, state.thirdPlaceRankings);
    updateLiveFlags();
    await enrichGamesWithEspn();

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
    showLoadError(err);
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

function closeGoalClipOverlay(card) {
  const overlay = card?.querySelector('.ge-clip-overlay');
  if (!overlay) return;
  const iframe = overlay.querySelector('iframe');
  if (iframe) iframe.removeAttribute('src');
  overlay.hidden = true;
  card.classList.remove('has-clip-open');
}

function ensureGoalClipOverlay(card) {
  let overlay = card.querySelector('.ge-clip-overlay');
  if (overlay) return overlay;

  card.insertAdjacentHTML('beforeend', `
    <div class="ge-clip-overlay" hidden>
      <div class="ge-clip-modal" role="dialog" aria-modal="true" aria-label="Goal highlight">
        <div class="ge-clip-modal-head">
          <span class="ge-clip-modal-title">Goal highlight</span>
          <button type="button" class="ge-clip-close" aria-label="Close highlight">✕</button>
        </div>
        <div class="ge-clip-modal-body">
          <iframe
            title="Goal highlight"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </div>
      </div>
    </div>`);
  return card.querySelector('.ge-clip-overlay');
}

function openGoalClipOverlay(card, videoId, title) {
  document.querySelectorAll('.se-card.has-clip-open').forEach((c) => {
    if (c !== card) closeGoalClipOverlay(c);
  });
  const overlay = ensureGoalClipOverlay(card);
  const iframe = overlay.querySelector('iframe');
  const titleEl = overlay.querySelector('.ge-clip-modal-title');
  if (titleEl) titleEl.textContent = title || 'Goal highlight';
  if (iframe) iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
  overlay.hidden = false;
  card.classList.add('has-clip-open');
}

function initGoalClipControls() {
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.ge-clip-close');
    if (closeBtn) {
      closeGoalClipOverlay(closeBtn.closest('.se-card'));
      return;
    }

    const backdrop = e.target.closest('.ge-clip-overlay');
    if (backdrop && e.target === backdrop) {
      closeGoalClipOverlay(backdrop.closest('.se-card'));
      return;
    }

    const btn = e.target.closest('.ge-clip-btn');
    if (!btn || btn.disabled) return;
    const videoId = btn.dataset.yt;
    if (!videoId) return;
    const card = btn.closest('.se-card');
    if (!card) return;
    openGoalClipOverlay(card, videoId, btn.title);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.se-card.has-clip-open').forEach((card) => closeGoalClipOverlay(card));
  });
}

// ── Init ─────────────────────────────────────────────────────────

initGoalClipControls();
$('#refresh-btn')?.addEventListener('click', loadData);
renderGroupTabs();
initNav();
state.tickTimer = setInterval(tick, 1000);
loadData();