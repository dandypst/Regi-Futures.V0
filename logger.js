// logger.js — Centralized logger with levels and file output
// Standalone: can be imported by any module without side effects

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const LOG_DIR = './logs';
const LOG_FILE = resolve(LOG_DIR, 'agent.log');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
};

function timestamp() {
  return new Date().toISOString();
}

function colorize(level) {
  switch (level) {
    case 'INFO':  return COLORS.cyan;
    case 'TRADE': return COLORS.green;
    case 'WARN':  return COLORS.yellow;
    case 'ERROR': return COLORS.red;
    case 'AI':    return COLORS.magenta;
    case 'SYS':   return COLORS.blue;
    default:      return COLORS.white;
  }
}

function writeLog(level, module, msg, data) {
  const ts = timestamp();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  const line = `[${ts}] [${level}] [${module}] ${msg}${dataStr}`;

  // Console
  const color = colorize(level);
  console.log(`${color}${line}${COLORS.reset}`);

  // File (no colors)
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}

  return line;
}

// Exported event listeners (dashboard subscribes to these)
const listeners = [];

export function onLog(fn) {
  listeners.push(fn);
}

function emit(entry) {
  for (const fn of listeners) {
    try { fn(entry); } catch (_) {}
  }
}

export const logger = {
  info:  (mod, msg, data) => { const e = writeLog('INFO',  mod, msg, data); emit({ level: 'INFO',  module: mod, msg, data, ts: timestamp() }); },
  trade: (mod, msg, data) => { const e = writeLog('TRADE', mod, msg, data); emit({ level: 'TRADE', module: mod, msg, data, ts: timestamp() }); },
  warn:  (mod, msg, data) => { const e = writeLog('WARN',  mod, msg, data); emit({ level: 'WARN',  module: mod, msg, data, ts: timestamp() }); },
  error: (mod, msg, data) => { const e = writeLog('ERROR', mod, msg, data); emit({ level: 'ERROR', module: mod, msg, data, ts: timestamp() }); },
  ai:    (mod, msg, data) => { const e = writeLog('AI',    mod, msg, data); emit({ level: 'AI',    module: mod, msg, data, ts: timestamp() }); },
  sys:   (mod, msg, data) => { const e = writeLog('SYS',   mod, msg, data); emit({ level: 'SYS',   module: mod, msg, data, ts: timestamp() }); },
};
