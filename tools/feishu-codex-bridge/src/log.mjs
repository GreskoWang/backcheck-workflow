import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact.mjs';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function safeDetails(details) {
  if (!details) return '';
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  return redactSecrets(text).slice(0, 4000);
}

export function createLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'bridge.log');

  function rotateIfNeeded() {
    try {
      if (fs.statSync(logPath).size < MAX_LOG_BYTES) return;
      const oldPath = `${logPath}.1`;
      if (fs.existsSync(oldPath)) fs.rmSync(oldPath);
      fs.renameSync(logPath, oldPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('log rotation failed:', error.message);
    }
  }

  function write(level, message, details) {
    const suffix = safeDetails(details);
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactSecrets(message)}${suffix ? ` ${suffix}` : ''}`;
    console.log(line);
    rotateIfNeeded();
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  }

  return {
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
  };
}

