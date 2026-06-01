const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────
const LOG_DIR = process.env.LOG_DIR || './logs';
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFileName = `agent_run_${timestamp}.log`;
const logFilePath = path.join(LOG_DIR, logFileName);

// ─── Ensure log directory exists ─────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ─── ANSI Color Codes ───────────────────────────────────────────────────────
const COLORS = {
  INFO:    '\x1b[36m',
  ACTION:  '\x1b[33m',
  AI:      '\x1b[35m',
  ERROR:   '\x1b[31m',
  SUCCESS: '\x1b[32m',
  RESET:   '\x1b[0m',
};

// ─── Socket.IO emitter for real-time dashboard ──────────────────────────────
let emitter = null;

// ─── Core log function ──────────────────────────────────────────────────────
function log(level, message) {
  const now = new Date().toISOString();
  const plainLine = `[${now}] [${level}] ${message}`;
  const color = COLORS[level] || COLORS.RESET;

  // Console output (color-coded)
  console.log(`${color}[${now}] [${level}]${COLORS.RESET} ${message}`);

  // File output (plain text)
  try {
    fs.appendFileSync(logFilePath, plainLine + '\n');
  } catch (err) {
    // Silently fail file writes
  }

  // Emit to dashboard via Socket.IO
  if (emitter) {
    try {
      emitter.emit('log', { level, message, timestamp: now });
    } catch (err) {
      // Silently fail socket emissions
    }
  }
}

// ─── Exported logger ────────────────────────────────────────────────────────
const logger = {
  info:    (msg) => log('INFO', msg),
  action:  (msg) => log('ACTION', msg),
  ai:      (msg) => log('AI', msg),
  error:   (msg) => log('ERROR', msg),
  success: (msg) => log('SUCCESS', msg),

  /** Set a Socket.IO socket or EventEmitter for real-time log streaming */
  setEmitter: (e) => { emitter = e; },

  /** Get the current log file path */
  getLogFile: () => logFilePath,
};

module.exports = logger;
