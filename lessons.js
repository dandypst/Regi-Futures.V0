// lessons.js — Persistent lesson storage

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DATA_DIR     = resolve(__dirname, 'data');
const LESSONS_FILE = resolve(DATA_DIR, 'lessons.json');
const MOD          = 'LESSONS';

try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

let _lessons = [];

export function loadLessons() {
  try {
    if (existsSync(LESSONS_FILE)) {
      _lessons = JSON.parse(readFileSync(LESSONS_FILE, 'utf-8'));
      logger.sys(MOD, `Loaded ${_lessons.length} lessons`);
    }
  } catch (e) {
    logger.warn(MOD, 'No lessons found, starting fresh');
    _lessons = [];
  }
}

export function saveLessons() {
  try { writeFileSync(LESSONS_FILE, JSON.stringify(_lessons, null, 2)); } catch (e) {
    logger.error(MOD, `Could not save lessons: ${e.message}`);
  }
}

export function getLessons()    { return [..._lessons]; }
export function addLesson(l)    {
  _lessons.push({ ...l, id: Date.now(), createdAt: new Date().toISOString() });
  saveLessons();
  logger.ai(MOD, `Lesson saved: ${l.insight?.slice(0,80)}`);
}

export function getLessonsContext() {
  if (!_lessons.length) return '';
  return `\n\n## LEARNED LESSONS (${_lessons.length} total, last 15):\n` +
    _lessons.slice(-15).map((l, i) =>
      `${i+1}. [${l.pair||'GENERAL'}][${l.direction||'ANY'}] ${l.insight} (${l.confidence||'medium'})`
    ).join('\n');
}

export async function generateLessonsFromTrades(tradeHistory) {
  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    logger.warn(MOD, 'No OpenRouter key — skip AI lesson generation'); return 0;
  }
  if (tradeHistory.length < 3) {
    logger.info(MOD, 'Need 3+ trades to generate lessons'); return 0;
  }

  const summary = tradeHistory.map(t =>
    `${t.symbol} ${t.side} entry:${t.entryPrice} exit:${t.exitPrice} pnl:${t.pnl?.toFixed(2)} reason:${t.closeReason} date:${t.closedAt}`
  ).join('\n');

  const prompt = `Analyze these futures trades and extract 4-8 actionable lessons.
${summary}
Respond ONLY with raw JSON array:
[{"pair":"BTCUSDT","direction":"LONG","insight":"insight max 120 chars","confidence":"high"}]`;

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { model: config.openRouterModel || 'anthropic/claude-3-haiku', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'Authorization': `Bearer ${config.openRouterApiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const clean = res.data.choices[0].message.content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
    const list  = JSON.parse(clean);
    let added = 0;
    for (const l of list) { if (l.insight) { addLesson({ ...l, source: 'ai' }); added++; } }
    logger.ai(MOD, `Generated ${added} new lessons`);
    return added;
  } catch (e) {
    logger.error(MOD, `Lesson generation failed: ${e.message}`); return 0;
  }
}
