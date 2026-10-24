import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {loadMcpClient} from './runtime-paths.mjs';
const {Client, StdioClientTransport} = await loadMcpClient();

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const secureLauncher = path.join(scriptDir, "secure-launcher.mjs");
const withoutProxy = process.argv.includes("--without-proxy");
const transportEnv = { ...process.env };
if (withoutProxy) {
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete transportEnv[key];
  }
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [secureLauncher],
  env: transportEnv,
  stderr: "inherit",
});

const client = new Client({ name: "feishu-mcp-live-verifier", version: "1.0.0" });

try {
  console.error("正在启动飞书 MCP…");
  await client.connect(transport);
  console.error("MCP 已启动，正在检查工具…");

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  if (!names.includes("docx_builtin_search")) {
    throw new Error("MCP 未提供 docx_builtin_search 工具");
  }

  // 使用不会命中真实文档的探针关键词，只验证用户身份下的只读 API 是否可调用。
  console.error("工具已发现，正在执行只读权限探针…");
  const searchResult = await client.callTool(
    {
      name: "docx_builtin_search",
      arguments: {
        data: {
          search_key: "__codex_feishu_mcp_connectivity_check_20260806__",
          count: 1,
          offset: 0,
        },
        useUAT: true,
      },
    },
    undefined,
    { timeout: 20_000 },
  );

  if (searchResult.isError) {
    const detail = searchResult.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ");
    throw new Error(`飞书只读搜索调用失败：${detail || "未知错误"}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        authMode: "user_access_token",
        toolCount: names.length,
        readOnlySearch: "succeeded",
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
