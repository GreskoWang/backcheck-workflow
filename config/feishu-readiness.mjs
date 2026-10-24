// Explicitly invoked, read-only online checks. --bind writes only local binding.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { localConfig, configPath } from './backcheck-config.mjs';
import { readFeishuCredential } from '../tools/feishu-codex-bridge/src/credentials.mjs';

const root = process.env.BACKGROUND_CHECK_WORKSPACE;
const requireBridge = createRequire(path.join(root, 'tools/feishu-codex-bridge/package.json'));
const Lark = requireBridge('@larksuiteoapi/node-sdk');
function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}
async function templateProbe() {
  const {loadMcpClient} = await import('../external/feishu-mcp/scripts/runtime-paths.mjs');
  const {Client, StdioClientTransport} = await loadMcpClient();
  const transport = new StdioClientTransport({command: process.execPath,
    args: [path.join(process.env.FEISHU_MCP_ROOT, 'scripts/secure-launcher.mjs')],
    env: {...process.env}, stderr: 'pipe'});
  const client = new Client({name: 'backcheck-restore-readonly', version: '1.0.0'});
  try {
    await client.connect(transport);
    const output = await client.callTool({name: 'docx_v1_document_get', arguments: {
      path: {document_id: localConfig.template_document_token}, useUAT: true,
    }}, undefined, {timeout: 20000});
    if (output.isError) throw new Error('Template cannot be read with the current Feishu user access');
    const data = output.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new Error('Template API response was not valid JSON'); }
    const doc = parsed.data?.document || parsed.document;
    if (parsed.code !== undefined && parsed.code !== 0 || doc?.document_id !== localConfig.template_document_token) {
      throw new Error('Template API did not confirm the expected document ID');
    }
    saveJson(path.join(root, 'config/template-read-check.json'), {checked_at: new Date().toISOString(),
      document_id: doc.document_id, title: doc.title, revision_id: doc.revision_id});
    return true;
  } finally { await client.close().catch(() => {}); }
}

try {
  const credential = await readFeishuCredential(process.env.FEISHU_CREDENTIAL_READER);
  if (credential.appId !== localConfig.app_id) throw new Error('Stored App ID differs from local configuration');
  const client = new Lark.Client({appId: credential.appId, appSecret: credential.appSecret,
    loggerLevel: Lark.LoggerLevel.fatal, logger: {trace(){},debug(){},info(){},warn(){},error(){},fatal(){}}});
  const bot = await client.request({url: '/open-apis/bot/v3/info', method: 'GET'});
  if (bot.code !== 0) throw new Error(`Bot access failed (code ${bot.code})`);
  const groups = [];
  let page_token;
  do {
    const response = await client.im.v1.chat.list({params: {page_size: 100, ...(page_token ? {page_token} : {})}});
    if (response.code !== 0) throw new Error(`Group list access failed (code ${response.code})`);
    groups.push(...(response.data?.items || []).map(({chat_id, name}) => ({chat_id, name})));
    page_token = response.data?.has_more ? response.data.page_token : undefined;
    if (response.data?.has_more && !page_token) throw new Error('Group list pagination did not return a token');
  } while (page_token);
  credential.appSecret = undefined;
  const bindIndex = process.argv.indexOf('--bind');
  if (bindIndex !== -1) {
    const id = process.argv[bindIndex + 1];
    const group = groups.find(group => group.chat_id === id);
    if (!group) throw new Error('Selected group is not visible to this bot; add the bot to the intended group first');
    const bindingPath = path.join(root, 'tools/feishu-codex-bridge/state/binding.json');
    if (fs.existsSync(bindingPath) && JSON.parse(fs.readFileSync(bindingPath, 'utf8')).chatId !== id) {
      throw new Error('A different group is already bound; inspect it before changing targets');
    }
    saveJson(bindingPath, {chatId: id, chatName: group.name, inviteUrl: localConfig.target_group_invite_url,
      boundAt: new Date().toISOString(), source: 'local-operator-selection'});
    localConfig.target_chat_id = id;
    saveJson(configPath, localConfig);
    console.log(JSON.stringify({bound: true, group, messages_sent: 0}, null, 2));
  } else {
    let templateError;
    try { localConfig.template_read_verified = await templateProbe(); }
    catch (error) { localConfig.template_read_verified = false; templateError = error.message; }
    saveJson(configPath, localConfig);
    console.log(JSON.stringify({bot_ready: true, groups, template_read_verified: localConfig.template_read_verified,
      ...(templateError ? {template_error: templateError} : {}), messages_sent: 0}, null, 2));
    if (templateError) process.exitCode = 1;
  }
} catch (error) {
  // Do not expose SDK response objects, HTTP headers, or captured credentials.
  console.error(error?.code ? `Feishu setup check failed (${error.code})` : String(error.message).slice(0, 250));
  process.exitCode = 1;
}
