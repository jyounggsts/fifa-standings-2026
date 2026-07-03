#!/usr/bin/env node
/**
 * Discovers per-goal highlight clips (FOX Sports YouTube + ESPN summary videos)
 * and caches matches in data/goal-clips.json for same-origin client fetch.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
const OUT_PATHS = [
  join(ROOT, 'data/goal-clips.json'),
  join(ROOT, 'docs/data/goal-clips.json'),
];
const UA = 'Mozilla/5.0 (compatible; fifa-standings-sync/1.0)';

function normalizeTeamKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function goalKey(goal) {
  return `${goal.side}|${goal.minute}|${goal.player}`;
}

function parseEspnGoal(play, espnHomeTeamId) {
  const participants = play.participants || [];
  const scorerPart = participants.find((p) => p.type !== 'assist') || participants[0];
  const side = String(play.team?.id) === String(espnHomeTeamId) ? 'home' : 'away';
  return {
    espnId: play.id,
    player: scorerPart?.athlete?.displayName || 'Unknown',
    minute: (play.clock?.displayValue || '').replace(/'/g, ''),
    side,
    type: play.type?.text?.toLowerCase().includes('header') ? 'header'
      : play.type?.text?.toLowerCase().includes('penalty') ? 'penalty' : 'open_play',
  };
}

function isCompilationClip(title) {
  const t = title.toLowerCase();
  return /all \d+ goals|every goal|extended highlights|full highlights|best goals|top \d+ goals/i.test(t);
}

function isWeakClip(title) {
  const t = title.toLowerCase();
  return /fans|celebrate|react|presser|analysis|should .* have|reflects on|questions|lucky to be/i.test(t);
}

function isGoalClipTitle(title) {
  if (!title || isCompilationClip(title) || isWeakClip(title)) return false;
  return /scores|nets|strike|goal|header|penalty|brace|hat-trick|equaliz|takes lead|pulls? ahead/i.test(title);
}

function playerMatchesTitle(player, title) {
  const t = title.toLowerCase();
  const p = player.toLowerCase();
  if (t.includes(p)) return true;
  const parts = player.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && last.length > 2 && t.includes(last.toLowerCase())) return true;
  const first = parts[0];
  if (first && first.length > 2 && t.includes(first.toLowerCase())) return true;
  return false;
}

function teamsMatchGame(title, home, away) {
  const t = title.toLowerCase();
  const h = home.toLowerCase();
  const a = away.toLowerCase();
  const hHit = h && t.includes(h);
  const aHit = a && t.includes(a);
  if (hHit && aHit) return true;
  if (hHit || aHit) return true;
  return false;
}

async function fetchEspn(path) {
  const res = await fetch(`${ESPN_API}${path}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

function matchGameToEspnEvent(game, events) {
  const home = normalizeTeamKey(game.home_team_name_en);
  const away = normalizeTeamKey(game.away_team_name_en);
  return (events || []).find((event) => {
    const comps = event.competitions?.[0]?.competitors || [];
    const espnHome = comps.find((c) => c.homeAway === 'home');
    const espnAway = comps.find((c) => c.homeAway === 'away');
    return normalizeTeamKey(espnHome?.team?.displayName) === home
      && normalizeTeamKey(espnAway?.team?.displayName) === away;
  });
}

async function scrapeYoutubeSearch(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
  const html = await res.text();
  const entries = [];
  const seen = new Set();
  for (const m of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    entries.push({ videoId: m[1], title: '' });
  }
  for (const m of html.matchAll(/"title":\{"runs":\[\{"text":"([^"]+)"/g)) {
    const title = m[1];
    const vid = entries.find((e) => !e.title);
    if (vid) vid.title = title;
  }
  return entries.filter((e) => e.title);
}

function pickClipFromPool(goal, home, away, pool) {
  const ranked = pool
    .filter((c) => isGoalClipTitle(c.title) && playerMatchesTitle(goal.player, c.title))
    .map((c) => {
      let score = 0;
      if (playerMatchesTitle(goal.player, c.title)) score += 3;
      if (teamsMatchGame(c.title, home, away)) score += 2;
      if (/fox/i.test(c.title)) score += 1;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

function pickEspnClip(goal, home, away, videos) {
  const ranked = (videos || [])
    .filter((v) => isGoalClipTitle(v.headline) && playerMatchesTitle(goal.player, v.headline))
    .map((v) => ({
      videoId: null,
      espnId: v.id,
      title: v.headline,
      thumb: v.thumbnail,
      webUrl: v.links?.web?.href,
      source: 'espn',
      score: teamsMatchGame(v.headline, home, away) ? 2 : 1,
    }))
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

function parseLocalDate(str) {
  const m = String(str || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

function isLiveGame(game) {
  const live = String(game.time_elapsed || '').toLowerCase();
  return live && !['finished', 'ft', ''].includes(live);
}

function isKickoffToday(game) {
  const kickoff = parseLocalDate(game.local_date);
  if (!kickoff || Number.isNaN(kickoff.getTime())) return false;
  const now = new Date();
  return kickoff.getFullYear() === now.getFullYear()
    && kickoff.getMonth() === now.getMonth()
    && kickoff.getDate() === now.getDate();
}

function isRecentGame(game) {
  if (isLiveGame(game) || isKickoffToday(game)) return true;
  const kickoff = parseLocalDate(game.local_date);
  if (!kickoff || Number.isNaN(kickoff.getTime())) return false;
  return (Date.now() - kickoff.getTime()) / 86_400_000 <= 2;
}

async function loadExisting() {
  try {
    const raw = await readFile(OUT_PATHS[0], 'utf8');
    return JSON.parse(raw);
  } catch {
    return { fetchedAt: null, games: {} };
  }
}

const gamesData = JSON.parse(await readFile(join(ROOT, 'data/games.json'), 'utf8'));
const teamsData = JSON.parse(await readFile(join(ROOT, 'data/teams.json'), 'utf8'));
const teamsMap = Object.fromEntries(teamsData.teams.map((t) => [t.id, t]));
const existing = await loadExisting();
const out = { fetchedAt: new Date().toISOString(), games: { ...existing.games } };

const targetGames = gamesData.games.filter(isRecentGame);
const dates = [...new Set(targetGames.map((g) => {
  const d = parseLocalDate(g.local_date);
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}).filter(Boolean))];

const boards = await Promise.all(
  dates.map((d) => fetchEspn(`/scoreboard?dates=${d}`).catch(() => ({ events: [] }))),
);
const allEvents = boards.flatMap((b) => b.events || []);

let ytPool = [];
try {
  ytPool = await scrapeYoutubeSearch('FOX Sports World Cup goal 2026');
} catch (err) {
  console.warn('YouTube pool fetch failed:', err.message);
}

let searchBudget = 4;

for (const game of targetGames) {
  const espnEvent = matchGameToEspnEvent(game, allEvents);
  if (!espnEvent) continue;

  const home = game.home_team_name_en || teamsMap[game.home_team_id]?.name_en || '';
  const away = game.away_team_name_en || teamsMap[game.away_team_id]?.name_en || '';
  let summary;
  try {
    summary = await fetchEspn(`/summary?event=${espnEvent.id}`);
  } catch {
    continue;
  }

  const espnHomeTeamId = summary.header?.competitions?.[0]?.competitors
    ?.find((c) => c.homeAway === 'home')?.id;
  const goals = (summary.keyEvents || [])
    .filter((e) => e.scoringPlay)
    .map((e) => parseEspnGoal(e, espnHomeTeamId));
  if (!goals.length) continue;

  if (!out.games[game.id]) out.games[game.id] = { goals: {} };
  const gameClips = out.games[game.id].goals;

  for (const goal of goals) {
    const key = goalKey(goal);
    if (gameClips[key]?.videoId || gameClips[key]?.webUrl) continue;

    let clip = pickEspnClip(goal, home, away, summary.videos);
    if (!clip?.webUrl) {
      const fromPool = pickClipFromPool(goal, home, away, ytPool);
      if (fromPool) {
        clip = {
          videoId: fromPool.videoId,
          title: fromPool.title,
          thumb: `https://i.ytimg.com/vi/${fromPool.videoId}/hqdefault.jpg`,
          source: 'fox-youtube',
        };
      }
    }

    const needsSearch = (isLiveGame(game) || isKickoffToday(game)) && searchBudget > 0;
    if (!clip?.videoId && !clip?.webUrl && needsSearch) {
      try {
        const search = await scrapeYoutubeSearch(`FOX Sports ${goal.player} goal World Cup 2026`);
        searchBudget -= 1;
        await new Promise((r) => setTimeout(r, 500));
        const found = pickClipFromPool(goal, home, away, search);
        if (found) {
          clip = {
            videoId: found.videoId,
            title: found.title,
            thumb: `https://i.ytimg.com/vi/${found.videoId}/hqdefault.jpg`,
            source: 'fox-youtube',
          };
        }
      } catch (err) {
        console.warn(`Search failed for ${goal.player}:`, err.message);
      }
    }

    if (clip?.videoId || clip?.webUrl) {
      gameClips[key] = {
        ...clip,
        matchedAt: new Date().toISOString(),
      };
    }
  }
}

const json = `${JSON.stringify(out, null, 2)}\n`;
for (const path of OUT_PATHS) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, 'utf8');
}

const clipCount = Object.values(out.games).reduce((n, g) => n + Object.keys(g.goals || {}).length, 0);
console.log(`goal-clips: ${clipCount} clips across ${Object.keys(out.games).length} games`);