// Probe-only terminal observation. Raw PTY bytes stay in memory and never leave
// this module. Known diagnostic lines are scrubbed before they are displayed.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MAX_RAW_CHARS = 200_000;

function blankRow(cols) { return Array(cols).fill(' '); }

export function renderAnsiScreen(raw, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
  const cells = Array.from({ length: rows }, () => blankRow(cols));
  let x = 0;
  let y = 0;
  const scroll = () => { cells.shift(); cells.push(blankRow(cols)); y = rows - 1; };
  const clamp = (value, limit) => Math.max(0, Math.min(limit - 1, value));
  const clearRange = (row, start, end) => {
    for (let col = Math.max(0, start); col < Math.min(cols, end); col++) cells[row][col] = ' ';
  };
  for (let i = 0; i < raw.length;) {
    const char = raw[i];
    if (char === '\x1b') {
      if (raw[i + 1] === ']') {
        i += 2;
        while (i < raw.length && raw[i] !== '\x07' && !(raw[i] === '\x1b' && raw[i + 1] === '\\')) i++;
        i += raw[i] === '\x1b' ? 2 : 1;
        continue;
      }
      if (raw[i + 1] === '[') {
        const match = raw.slice(i + 2).match(/^([0-?]*[ -/]*)([@-~])/u);
        if (!match) { i++; continue; }
        const params = match[1].replace(/^[?<>=]/u, '').split(';').map((item) => Number(item) || 0);
        const n = params[0] || 1;
        const op = match[2];
        if (op === 'H' || op === 'f') { y = clamp((params[0] || 1) - 1, rows); x = clamp((params[1] || 1) - 1, cols); }
        else if (op === 'G') x = clamp(n - 1, cols);
        else if (op === 'd') y = clamp(n - 1, rows);
        else if (op === 'A') y = clamp(y - n, rows);
        else if (op === 'B') y = clamp(y + n, rows);
        else if (op === 'C') x = clamp(x + n, cols);
        else if (op === 'D') x = clamp(x - n, cols);
        else if (op === 'K') {
          if (params[0] === 1) clearRange(y, 0, x + 1);
          else if (params[0] === 2) clearRange(y, 0, cols);
          else clearRange(y, x, cols);
        } else if (op === 'J') {
          if (params[0] === 2 || params[0] === 3) {
            for (let row = 0; row < rows; row++) clearRange(row, 0, cols);
          } else if (params[0] === 1) {
            for (let row = 0; row <= y; row++) clearRange(row, 0, row === y ? x + 1 : cols);
          } else {
            for (let row = y; row < rows; row++) clearRange(row, row === y ? x : 0, cols);
          }
        }
        i += 2 + match[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    if (char === '\r') { x = 0; i++; continue; }
    if (char === '\n') { y++; if (y >= rows) scroll(); i++; continue; }
    if (char === '\b') { x = Math.max(0, x - 1); i++; continue; }
    if (char === '\t') { x = Math.min(cols - 1, Math.ceil((x + 1) / 8) * 8); i++; continue; }
    const point = raw.codePointAt(i);
    const glyph = String.fromCodePoint(point);
    i += glyph.length;
    if (point < 0x20 || point === 0x7f) continue;
    if (x >= cols) { x = 0; y++; if (y >= rows) scroll(); }
    cells[y][x++] = glyph;
  }
  return cells.map((row) => row.join('').trimEnd());
}

function authOrTrustBlock(screenText) {
  if (/sign\s*in\s+(?:to|with)|log\s*in\s+(?:to|with)|device\s*code|scan.*(?:qr|code)|qr\s*code|provide\s+(?:your\s+own\s+)?api\s*key|choose.*sign\s*in|二维码|扫码/iu.test(screenText) ||
      (/登录/iu.test(screenText) && !/登录.{0,12}(?:错误|失败|超时)|(?:错误|失败|超时).{0,12}登录/iu.test(screenText))) {
    return '登录/授权阻塞（认证画面已整体隐藏）';
  }
  return null;
}

// A redaction hit marks authentication-sensitive visible text; it does not
// establish that the account needs a new login.
export function detectAuthSensitiveScreen(raw, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
  return Boolean(authOrTrustBlock(renderAnsiScreen(raw, { cols, rows }).join('\n')));
}

// Require a recognizable UI prompt plus a separate action cue. A sentence in
// the research prompt about logging in remains sensitive for redaction, but is
// not treated as evidence that the CLI is requesting account authentication.
export function detectConfirmedAuthScreen(raw, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
  const lines = renderAnsiScreen(raw, { cols, rows }).map((line) => line.trim()).filter(Boolean);
  const heading = lines.some((line) =>
    /^(?:Sign in to Codex|Log in to Codex|Choose (?:a |your )?sign.in method)/iu.test(line));
  const choice = lines.some((line) =>
    /(?:Sign in with ChatGPT|Continue with ChatGPT|Use (?:your )?API key|Choose (?:a |your )?sign.in method)/iu.test(line));
  const device = lines.some((line) => /device\s*code|QR\s*code/iu.test(line));
  const deviceAction = lines.some((line) => /(?:visit|open).*browser|scan.*(?:QR|code)|enter.*code/iu.test(line));
  return (heading && choice && lines.length >= 2) || (device && deviceAction && lines.length >= 2);
}

export function detectTrustConfirmation(raw, { workspace, cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
  const screen = renderAnsiScreen(raw, { cols, rows });
  const text = screen.join(' ').replace(/\s+/gu, ' ');
  // The installed Codex 0.158.0 trust widget renders these three separate UI
  // elements. A quoted trust phrase in a prompt or transcript is insufficient.
  if (!/Folder access/iu.test(text) || !/Trust this folder\?/iu.test(text) ||
      !/Trust and continue/iu.test(text)) return null;
  const paths = screen.map((line) => line.trim())
    .filter((line) => /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|mnt|workspace)\/)/u.test(line));
  const trustTarget = paths.at(-1) || null;
  return { workspace: workspace || null, trustTarget };
}

export function detectUpdateConfirmation(raw, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
  const text = renderAnsiScreen(raw, { cols, rows }).join(' ').replace(/\s+/gu, ' ');
  return /Update available/iu.test(text) && /Update now/iu.test(text) &&
    /Skip/iu.test(text);
}

function trustConfirmationSummary(trust) {
  const target = trust.trustTarget || '画面未清晰显示目录；请在本机确认路径';
  const matchesWorkspace = trust.workspace && trust.trustTarget &&
    trust.workspace.replaceAll('\\', '/').toLowerCase() === trust.trustTarget.replaceAll('\\', '/').toLowerCase();
  return [
    '工作区信任确认（已匹配完整 Codex 确认页；未自动接受）',
    '关键提示：Trust this folder? / Trust and continue / Quit',
    `画面确认目标：${target}`,
    trust.workspace ? `本次 CLI 工作目录：${trust.workspace}${matchesWorkspace ? '（与确认目标一致）' : ''}` : '',
    '权限后果：Codex 可按权限设置读取、编辑和运行该目录文件；文件夹设置可能在没有模型请求时自动运行代码；信任决定会保存。',
  ].filter(Boolean).join('\n');
}

const DIAGNOSTIC_PATTERN = /\b(?:error|failed|failure|warning|unable|cannot|can't|denied|invalid|unsupported|unavailable|timeout|timed\s*out|disconnected|reconnecting|rate\s*limit|http\s*[1-5]\d\d|eacces|eperm|enoent|etimedout|econn\w*|dns|tls|certificate|unauthorized|forbidden|permission|not\s+found|no\s+such\s+file|went\s+wrong|try\s+again)\b|错误|失败|警告|拒绝|无权限|不可用|超时/iu;

export function redactDiagnosticLine(value) {
  let line = String(value || '');
  const errorCodes = [...line.matchAll(/\b(?:HTTP\s*[1-5]\d\d|os\s+error\s+\d+|EACCES|EPERM|ENOENT|ETIMEDOUT|ECONN[A-Z]+)\b/giu)]
    .map((match) => match[0]).slice(0, 3);
  line = line.replace(/\b(?:FEISHU_BATCH_|BATCH_THREAD_READY_|RQ-PROBE-)[A-Za-z0-9_-]+\b/gu, '[EMPTY_TASK_MARKER]');
  line = line.replace(/(?:https?|file):\/\/[^\s<>)\]}]+/giu, '[URL]');
  line = line.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]');
  // A filesystem path may contain spaces. Hide the rest of that line rather
  // than risk exposing the trailing portion of a quoted or unquoted path.
  line = line.replace(/\\\\[^\s]+.*$/u, '[PATH AND TAIL REDACTED]');
  line = line.replace(/\b[A-Za-z]:[\\/].*$/u, '[PATH AND TAIL REDACTED]');
  line = line.replace(/\/(?:Users|home|mnt|tmp|var|etc|private|opt)\/.*$/u, '[PATH AND TAIL REDACTED]');
  line = line.replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/-]+/giu, 'Bearer [REDACTED]');
  line = line.replace(/\b(openai_api_key|codex_api_key|api[ _-]?key|auth[ _-]?token|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|token|secret|password|cookie|authorization)\s*[:=].*$/giu, '$1=[REDACTED]');
  line = line.replace(/\b(?:sk|sess|rk|pk)-[A-Za-z0-9_-]{8,}\b/giu, '[REDACTED]');
  line = line.replace(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/gu, '[DEVICE_CODE]');
  line = line.replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/gu, '[HOST]');
  line = line.replace(/\b[A-Za-z0-9_+/-]{24,}={0,2}\b/gu, '[REDACTED]');
  line = line.replace(/[\p{L}\p{N}]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\p{L}\p{N}]*/gu, '[TEXT]');
  line = line.replace(/[\p{Cc}\p{Cf}]/gu, '');
  line = line.trim().slice(0, 240);
  for (const code of errorCodes) if (!line.toLowerCase().includes(code.toLowerCase())) line += ` [${code}]`;
  return line;
}

function labelLine(line, requestId, row, rows) {
  if (DIAGNOSTIC_PATTERN.test(line)) return `诊断：${redactDiagnosticLine(line)}`;
  if (line.includes(requestId) || /FEISHU_BATCH_/u.test(line)) {
    return row >= rows - 12 ? '编辑器附近可见本次空任务文本' : '对话区可见本次空任务文本';
  }
  if (/BATCH_THREAD_READY_/u.test(line)) return '固定回复标记出现在画面中（可能只是提示词回显，不能认定模型已回复）';
  if (/Ask Codex to do anything/iu.test(line)) return '› Ask Codex to do anything（输入编辑器）';
  if (/\bworking\b|\bthinking\b|\bgenerating\b|\bprocessing\b/iu.test(line)) return 'Working / Thinking（任务运行状态）';
  if (/\bready\b/iu.test(line)) return 'Ready（就绪状态栏）';
  if (/press\s+enter|enter\s+to|按回车/iu.test(line)) return '回车操作提示';
  return '非诊断画面文字已隐藏';
}

export function redactTerminalScreen(raw, { requestId, workspace, cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
  const screen = renderAnsiScreen(raw, { cols, rows });
  const blocker = authOrTrustBlock(screen.join('\n'));
  if (blocker) return blocker;
  const trust = detectTrustConfirmation(raw, { workspace, cols, rows });
  if (trust) return trustConfirmationSummary(trust);
  const visible = screen.map((line, row) => ({ line: line.trim(), row: row + 1 })).filter(({ line }) => line);
  if (!visible.length) return '终端画面尚无可见文字';
  return visible.slice(-18).map(({ line, row }) => `第${row}行：${labelLine(line, requestId, row, rows)}`).join('\n');
}

export class ProbeTerminalObserver {
  constructor(requestId, workspace = null) { this.requestId = requestId; this.workspace = workspace; this.raw = ''; }
  push(chunk) { this.raw = (this.raw + String(chunk)).slice(-MAX_RAW_CHARS); }
  snapshot() { return redactTerminalScreen(this.raw, { requestId: this.requestId, workspace: this.workspace }); }
}
