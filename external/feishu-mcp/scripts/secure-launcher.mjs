import { localConfig } from '../../../config/backcheck-config.mjs';
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const credentialReader = path.join(scriptDir, "read-credential.ps1");
import {cliPath} from './runtime-paths.mjs';

const credentialProcess = spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    credentialReader,
  ],
  {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  },
);

if (credentialProcess.status !== 0) {
  console.error("无法读取飞书凭证，请重新运行 configure-credentials.ps1。");
  process.exit(1);
}

let credential;
try {
  credential = JSON.parse(credentialProcess.stdout);
} catch {
  console.error("飞书凭证格式无效，请重新运行 configure-credentials.ps1。");
  process.exit(1);
}

if (
  typeof credential.app_id !== "string" ||
  !credential.app_id ||
  typeof credential.app_secret !== "string" ||
  !credential.app_secret
) {
  console.error("飞书凭证不完整，请重新运行 configure-credentials.ps1。");
  process.exit(1);
}

const enabledTools = [
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

const childEnvironment = {
  ...process.env,
  APP_ID: credential.app_id,
  APP_SECRET: credential.app_secret,
  LARK_DOMAIN: "https://open.feishu.cn",
  LARK_TOKEN_MODE: "user_access_token",
  LARK_TOOLS: enabledTools.join(","),
};

const child = spawn(
  process.execPath,
  [cliPath, "mcp", "--language", "zh", "--tool-name-case", "snake"],
  {
    env: childEnvironment,
    stdio: "inherit",
    windowsHide: true,
  },
);

credential.app_secret = undefined;
childEnvironment.APP_SECRET = undefined;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", () => {
  console.error("飞书 MCP 启动失败，请确认官方 lark-mcp 已安装。");
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
