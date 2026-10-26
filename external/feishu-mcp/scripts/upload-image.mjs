import {packageRoot} from './runtime-paths.mjs';
import { localConfig } from '../../../config/backcheck-config.mjs';
import { createHash } from "node:crypto";
import { readFile, realpath, stat, open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWED_ROOT = process.env.BACKGROUND_CHECK_WORKSPACE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMPLATE_DOCUMENT_ID = localConfig.template_document_token;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILE_NAME_BYTES = 250;
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;
const SUPPORTED_MCP_VERSION_PREFIX = "0.5.";

function usage() {
  return [
    "用法：",
    "  预检（默认，不写入）：",
    "  node upload-image.mjs --file <图片路径> --document-id <文档token> --image-block-id <空图片块id>",
    "",
    "  确认上传：",
    "  node upload-image.mjs --file <图片> --document-id <文档token> --image-block-id <空图片块id> --expected-sha256 <预检值> --commit",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    commit: false,
    explicitDryRun: false,
    replaceExisting: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--commit") {
      result.commit = true;
    } else if (arg === "--dry-run") {
      result.explicitDryRun = true;
    } else if (arg === "--replace-existing") {
      result.replaceExisting = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (
      arg === "--file" ||
      arg === "--document-id" ||
      arg === "--image-block-id" ||
      arg === "--expected-sha256"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} 缺少参数值`);
      }
      const key = {
        "--file": "file",
        "--document-id": "documentId",
        "--image-block-id": "imageBlockId",
        "--expected-sha256": "expectedSha256",
      }[arg];
      result[key] = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (result.commit && result.explicitDryRun) {
    throw new Error("--commit 与 --dry-run 不能同时使用");
  }
  if (result.replaceExisting && !result.commit) {
    throw new Error("--replace-existing 只能与 --commit 同时使用");
  }
  return result;
}

function verifyImageSignature(buffer, extension) {
  const isPng =
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg =
    buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";

  if (extension === ".png" && !isPng) {
    throw new Error("图片扩展名为 PNG，但文件内容不是有效的 PNG");
  }
  if ((extension === ".jpg" || extension === ".jpeg") && !isJpeg) {
    throw new Error("图片扩展名为 JPG/JPEG，但文件内容不是有效的 JPEG");
  }
  if (extension === ".webp" && !isWebp) {
    throw new Error("图片扩展名为 WebP，但文件内容不是有效的 WebP");
  }
}

async function validateInput(args) {
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(TEMPLATE_DOCUMENT_ID || "") || TEMPLATE_DOCUMENT_ID.startsWith("SYNTHETIC")) throw new Error("Configure the approved template first");
  if (!args.file) {
    throw new Error("必须提供 --file");
  }
  if (!SAFE_TOKEN_PATTERN.test(args.documentId || "")) {
    throw new Error("--document-id 格式无效");
  }
  if (args.documentId === TEMPLATE_DOCUMENT_ID || args.documentId.startsWith("SYNTHETICDOC")) {
    throw new Error("禁止向背调模板原件上传图片，请使用“使用该模板”后生成的新文档 token");
  }
  if (!SAFE_TOKEN_PATTERN.test(args.imageBlockId || "")) {
    throw new Error("--image-block-id 格式无效");
  }

  const allowedRoot = await realpath(ALLOWED_ROOT);
  const filePath = await realpath(path.resolve(args.file));
  const relative = path.relative(allowedRoot, filePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`仅允许上传 ${ALLOWED_ROOT} 目录内的图片`);
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("仅允许 PNG、JPG、JPEG 或 WebP 图片");
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error("--file 必须指向普通文件");
  }
  if (fileStat.size <= 0) {
    throw new Error("不能上传空文件");
  }
  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error("图片超过 20 MB，请先压缩后再上传");
  }

  const fileName = path.basename(filePath);
  if (Buffer.byteLength(fileName, "utf8") > MAX_FILE_NAME_BYTES) {
    throw new Error("图片文件名超过 250 字节，请缩短后再上传");
  }

  const buffer = await readFile(filePath);
  verifyImageSignature(buffer, extension);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { filePath, fileName, size: fileStat.size, buffer, sha256 };
}

function readCredential(scriptDir) {
  const credentialReader = path.join(scriptDir, "read-credential.ps1");
  const processResult = spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", credentialReader],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (processResult.status !== 0) {
    throw new Error("无法读取飞书凭证，请重新运行 configure-credentials.ps1");
  }

  let credential;
  try {
    credential = JSON.parse(processResult.stdout);
  } catch {
    throw new Error("飞书凭证格式无效，请重新运行 configure-credentials.ps1");
  } finally {
    processResult.stdout = "";
  }

  if (!credential?.app_id || !credential?.app_secret) {
    throw new Error("飞书凭证不完整，请重新运行 configure-credentials.ps1");
  }
  return credential;
}

function loadFeishuModules() {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const packageJson = require(path.join(packageRoot, "package.json"));
  if (!String(packageJson.version).startsWith(SUPPORTED_MCP_VERSION_PREFIX)) {
    throw new Error(
      `当前 lark-mcp 版本为 ${packageJson.version}，上传助手仅验证过 ${SUPPORTED_MCP_VERSION_PREFIX}x，请先复核兼容性`,
    );
  }
  return {
    lark: require("@larksuiteoapi/node-sdk"),
    authStore: require(path.join(packageRoot, "dist", "auth", "store.js")).authStore,
    isTokenValid: require(
      path.join(packageRoot, "dist", "auth", "utils", "is-token-valid.js"),
    ).isTokenValid,
    LarkAuthHandlerLocal: require(
      path.join(packageRoot, "dist", "auth", "handler", "handler-local.js"),
    ).LarkAuthHandlerLocal,
  };
}

async function getUserAccessToken(modules, credential) {
  const currentToken = await modules.authStore.getLocalAccessToken(credential.app_id);
  const status = await modules.isTokenValid(currentToken);
  if (status.valid) {
    return currentToken;
  }

  if (status.isExpired && status.token?.extra?.refreshToken) {
    const authHandler = new modules.LarkAuthHandlerLocal(
      {},
      {
        host: "localhost",
        port: 3000,
        domain: "https://open.feishu.cn",
        appId: credential.app_id,
        appSecret: credential.app_secret,
      },
    );
    const refreshed = await authHandler.refreshToken(currentToken);
    if (refreshed?.access_token) {
      return refreshed.access_token;
    }
  }

  throw new Error("飞书登录授权已失效，请重新运行 login-feishu.ps1");
}

async function acquireUploadLock() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("缺少 LOCALAPPDATA，无法创建上传互斥锁");
  }
  const lockPath = path.join(localAppData, "CodexFeishuMcp", "media-upload.lock");
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
      "utf8",
    );
    return { handle, lockPath };
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("已有截图上传任务正在运行；如确认没有任务，请检查 media-upload.lock");
    }
    throw error;
  }
}

async function releaseUploadLock(lock) {
  if (!lock) return;
  await lock.handle.close();
  await unlink(lock.lockPath).catch(() => {});
}

async function verifyImageBlock(client, lark, userAccessToken, args) {
  const result = await client.docx.documentBlock.get(
    {
      path: {
        document_id: args.documentId,
        block_id: args.imageBlockId,
      },
      params: { document_revision_id: -1 },
    },
    lark.withUserAccessToken(userAccessToken),
  );
  const block = result?.data?.block;
  if (!block || block.block_id !== args.imageBlockId) {
    throw new Error("无法在指定文档中确认图片块");
  }
  if (block.block_type !== 27) {
    throw new Error("指定 block 不是图片块");
  }
  if (block.image?.token && !args.replaceExisting) {
    throw new Error("图片块已有内容；如确需覆盖，必须显式使用 --replace-existing");
  }
}

function safeErrorText(error) {
  const responseData = error?.response?.data;
  if (responseData && typeof responseData === "object") {
    const parts = [];
    if (responseData.code !== undefined) parts.push(`code=${responseData.code}`);
    if (responseData.msg) parts.push(String(responseData.msg));
    if (parts.length) return parts.join(" ");
  }
  return error?.message || String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const input = await validateInput(args);
  if (!args.commit) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          file_name: input.fileName,
          size: input.size,
          sha256: input.sha256,
          document_id_valid: true,
          image_block_id_valid: true,
          allowed_root: ALLOWED_ROOT,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!/^[a-fA-F0-9]{64}$/.test(args.expectedSha256 || "")) {
    throw new Error("--commit 必须同时提供预检返回的 --expected-sha256");
  }
  if (args.expectedSha256.toLowerCase() !== input.sha256) {
    throw new Error("图片 SHA-256 与预检结果不一致，已停止上传");
  }

  const lock = await acquireUploadLock();
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  let credential;
  let modules;
  try {
    credential = readCredential(scriptDir);
    modules = loadFeishuModules();
    const userAccessToken = await getUserAccessToken(modules, credential);
    const silentLogger = {
      warn() {},
      error() {},
      debug() {},
      info() {},
      trace() {},
    };
    const client = new modules.lark.Client({
      appId: credential.app_id,
      appSecret: credential.app_secret,
      domain: modules.lark.Domain.Feishu,
      logger: silentLogger,
    });
    await verifyImageBlock(client, modules.lark, userAccessToken, args);
    const result = await client.drive.media.uploadAll(
      {
        data: {
          file_name: input.fileName,
          parent_type: "docx_image",
          parent_node: args.imageBlockId,
          size: input.size,
          extra: JSON.stringify({ drive_route_token: args.documentId }),
          file: input.buffer,
        },
      },
      modules.lark.withUserAccessToken(userAccessToken),
    );
    if (!result?.file_token) {
      throw new Error("飞书未返回图片 file_token");
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          file_token: result.file_token,
          image_token: result.file_token,
          image_block_id: args.imageBlockId,
          size: input.size,
          sha256: input.sha256,
          mode: "upload_all",
        },
        null,
        2,
      ),
    );
  } finally {
    if (credential) {
      credential.app_secret = undefined;
      credential.app_id = undefined;
    }
    try {
      modules?.authStore?.destroy?.();
    } finally {
      await releaseUploadLock(lock);
    }
  }
}

main().catch((error) => {
  console.error(`上传失败：${safeErrorText(error)}`);
  process.exitCode = 1;
});
