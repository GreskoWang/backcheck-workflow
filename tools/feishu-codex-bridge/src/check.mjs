import * as Lark from '@larksuiteoapi/node-sdk';
import { createLocalCodex } from './codex-client.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.mjs';
import { readFeishuCredential } from './credentials.mjs';
import { readLatestFeishuRevision } from './delivery-review.mjs';

function completedReportToken() {
  const jobs = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'jobs.json'), 'utf8'));
  for (const job of jobs) {
    if (job.status !== 'completed') continue;
    const token = String(job.finalResponse || '').match(/https:\/\/[^\s)\]]*feishu\.cn\/docx\/([A-Za-z0-9]+)/iu)?.[1];
    if (token) return token;
  }
  throw new Error('no completed historical docx report is available for a read-only revision probe');
}

async function checkFeishu() {
  const credential = await readFeishuCredential(config.credentialReader);
  const client = new Lark.Client({ appId: credential.appId, appSecret: credential.appSecret });
  const bot = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
  const chats = await client.im.v1.chat.list({ params: { page_size: 100 } });
  const reviewAccess = process.argv.includes('--review-access')
    ? await (async () => {
      try {
        const revisionId = await readLatestFeishuRevision(client, completedReportToken());
        return { ok: true, revisionId };
      } catch {
        return { ok: false, reason: 'historical_report_revision_unavailable' };
      }
    })()
    : undefined;
  credential.appSecret = undefined;
  return {
    ok: bot?.code === 0,
    botName: bot?.bot?.app_name,
    visibleChats: (chats?.data?.items || []).map((chat) => ({
      name: chat.name,
      chatIdSuffix: chat.chat_id?.slice(-6),
    })),
    ...(reviewAccess ? { reviewAccess } : {}),
  };
}

async function checkCodex() {
  const codex = createLocalCodex();
  const thread = codex.startThread({
    workingDirectory: config.workspace,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    modelReasoningEffort: 'low',
  });
  const result = await thread.run('Reply with exactly BRIDGE_CODEX_OK. Do not use tools.');
  return {
    ok: result.finalResponse.trim() === 'BRIDGE_CODEX_OK',
    response: result.finalResponse.trim(),
    threadId: thread.id,
  };
}

const output = { feishu: await checkFeishu() };
if (process.argv.includes('--codex')) output.codex = await checkCodex();
console.log(JSON.stringify(output, null, 2));
if (!output.feishu.ok || output.feishu.reviewAccess?.ok === false || output.codex?.ok === false) {
  process.exitCode = 1;
}
