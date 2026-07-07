// Tiny logger: timestamped lines to stdout, and best-effort to the configured
// log file. File logging is optional: on read-only/serverless filesystems (e.g.
// Vercel, where only /tmp is writable) the mkdir/append can fail — we must never
// let that crash module load or a request. stdout is always captured anyway.
const fs = require('fs');
const path = require('path');
const { config } = require('./config.cjs');

// Try once, at load, to ensure the log directory exists. If it fails (read-only
// FS), disable file logging entirely and fall back to stdout-only.
let fileLoggingEnabled = true;
try {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
} catch (e) {
  fileLoggingEnabled = false;
  console.warn(`[logger] file logging disabled (${e.code || e.message}); using stdout only`);
}

function write(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  if (!fileLoggingEnabled) return;
  try { fs.appendFileSync(config.logFile, line + '\n'); } catch { fileLoggingEnabled = false; }
}

module.exports = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  // Structured record of an execute_rule attempt (dry-run: signature omitted/DRY-RUN).
  attempt: (obj) => write('ATTEMPT', JSON.stringify(obj)),
};
