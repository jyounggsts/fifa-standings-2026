#!/usr/bin/env node
/**
 * Fetches FOX Sports YouTube /live metadata for same-origin embed cache.
 * Runs in GitHub Actions (no browser CORS).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOX_LIVE_URL = 'https://www.youtube.com/@FOXSports/live';
const OUT_PATHS = [
  join(ROOT, 'data/youtube-live.json'),
  join(ROOT, 'docs/data/youtube-live.json'),
];

function parseTeams(title) {
  if (!title) return [];
  const cleaned = title.replace(/\s*-\s*YouTube$/i, '').trim();
  const match = cleaned.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+[\u{1F1E6}-\u{1F1FF}]{2}|\s+\d{4}|\s*\||\s+2026|$)/iu);
  if (!match) return [];
  return [match[1].trim(), match[2].trim()];
}

async function fetchFoxYoutubeLive() {
  const res = await fetch(FOX_LIVE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fifa-standings-sync/1.0)' },
  });
  if (!res.ok) throw new Error(`YouTube fetch HTTP ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1]?.replace(/\s*-\s*YouTube$/i, '').trim() || '';
  const videoIds = [...new Set([...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((m) => m[1]))];
  const isLive = html.includes('"isLive":true') || html.includes('isLiveContent":true');
  return {
    fetchedAt: new Date().toISOString(),
    foxSports: {
      videoId: videoIds[0] || null,
      title,
      isLive,
      parsedTeams: parseTeams(title),
      channelUrl: 'https://www.youtube.com/@FOXSports/live',
    },
  };
}

const payload = await fetchFoxYoutubeLive();
const json = `${JSON.stringify(payload, null, 2)}\n`;

for (const path of OUT_PATHS) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, 'utf8');
}
console.log('youtube-live:', payload.foxSports.videoId, payload.foxSports.title, payload.foxSports.isLive);