import crypto from 'node:crypto';

const REQUEST_PREFIX = /^(?:\/)?背调(?:需求)?(?:\s*[:：-]\s*|\s+)([\s\S]+)$/u;
const DISPATCH_HEADER = /(?:^|\r?\n)\s*(?:\*\*|__)?(?:【|\[)\s*背调需求[^】\]]*(?:】|\])(?:\*\*|__)?/u;
const SCOPE_TEST_PREFIX = /(?:^|\r?\n)\s*(?:派单测试|测试派单)\s*(?:\r?\n|$)/u;
const STATUS_PREFIX = /^(?:\/)?状态(?:\s*[:：-]\s*|\s+)(RQ-[0-9A-Z-]+)$/iu;
const HELP = /^(?:\/)?(?:帮助|help)$/iu;
const PAIR = /^(?:\/)?绑定背调群\s+([23456789A-HJ-NP-Z]{8})$/iu;

export function parseCommand(content, maxRequestChars = 6000) {
  const text = String(content || '').replace(/\u00a0/g, ' ').trim();
  if (!text) return { kind: 'ignore' };

  const pair = text.match(PAIR);
  if (pair) return { kind: 'pair', code: pair[1].toUpperCase() };
  if (HELP.test(text)) return { kind: 'help' };

  const status = text.match(STATUS_PREFIX);
  if (status) return { kind: 'status', requestId: status[1].toUpperCase() };

  const request = text.match(REQUEST_PREFIX);
  const dispatchHeader = request ? null : text.match(DISPATCH_HEADER);
  const body = request
    ? request[1].trim()
    : dispatchHeader
      ? text.slice(dispatchHeader.index).replace(/^\r?\n/u, '').trim()
      : '';
  if (!body) return { kind: 'unknown' };
  if (body.length < 2) return { kind: 'invalid', reason: '需求内容过短' };
  if (body.length > maxRequestChars) {
    return { kind: 'invalid', reason: `需求超过 ${maxRequestChars} 字，请缩短后重发` };
  }
  if (dispatchHeader && SCOPE_TEST_PREFIX.test(text.slice(0, dispatchHeader.index + 1))) {
    return { kind: 'request', body, scopeOnly: true };
  }
  return { kind: 'request', body };
}

export function helpText() {
  return [
    '云CLI 背调入口',
    '',
    '发起：@云CLI 背调 对象名；主页链接；补充范围',
    '完整派单可直接发送“【背调需求…】”，也可在 @云CLI 背调 后粘贴',
    '本机只提取 TS、TS1、临A/A、临H/H、BK1、BK2',
    '查询：@云CLI 状态 RQ-请求编号',
    '',
    '每条需求独立排队执行；群内只回复一条完整接单表，不发送进度、结果或文档链接。',
  ].join('\n');
}

export function newRequestId(now = new Date(), random = cryptoRandom()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `RQ-${stamp}-${random.toUpperCase()}`;
}

function cryptoRandom() {
  return crypto.randomBytes(12).toString('hex');
}
