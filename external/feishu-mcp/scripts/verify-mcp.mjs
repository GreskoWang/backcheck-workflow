import path from "node:path";
import { pathToFileURL } from "node:url";

import {cliPath, loadMcpClient} from './runtime-paths.mjs';
const {Client, StdioClientTransport} = await loadMcpClient();

const tools = [
  "docx.v1.document.get",
  "docx.v1.document.rawContent",
  "docx.v1.document.create",
  "docx.v1.documentBlock.list",
  "docx.v1.documentBlock.get",
  "docx.v1.documentBlock.patch",
  "docx.v1.documentBlock.batchUpdate",
  "docx.v1.documentBlockChildren.create",
  "docx.v1.documentBlockChildren.batchDelete",
  "docx.builtin.search",
  "wiki.v1.node.search",
  "wiki.v2.space.getNode",
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliPath, "mcp", "--language", "zh", "--tool-name-case", "snake"],
  env: {
    ...process.env,
    APP_ID: "cli_protocol_check",
    APP_SECRET: "protocol-check-only",
    LARK_DOMAIN: "https://open.feishu.cn",
    LARK_TOKEN_MODE: "user_access_token",
    LARK_TOOLS: tools.join(","),
  },
  stderr: "pipe",
});

const client = new Client({ name: "feishu-mcp-verifier", version: "1.0.0" });
try {
  await client.connect(transport);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name).sort();
  const expected = tools.map((name) => name.replaceAll(".", "_")).sort();
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new Error(`缺少工具：${missing.join(", ")}`);
  }
  console.log(JSON.stringify({ ok: true, toolCount: names.length, tools: names }, null, 2));
} finally {
  await client.close();
}
