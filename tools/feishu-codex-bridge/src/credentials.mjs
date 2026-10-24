import { spawn } from 'node:child_process';
import fs from 'node:fs';

function collectProcess(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) child.kill();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`credential reader failed with exit code ${code}`));
    });
  });
}

export async function readFeishuCredential(readerPath) {
  if (!fs.existsSync(readerPath)) {
    throw new Error(`credential reader not found: ${readerPath}`);
  }

  const child = spawn(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', readerPath],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = await collectProcess(child);

  let credential;
  try {
    credential = JSON.parse(output);
  } catch {
    throw new Error('credential reader returned invalid JSON');
  }

  const appId = credential.app_id || credential.AppId || credential.APP_ID;
  const appSecret = credential.app_secret || credential.AppSecret || credential.APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('credential reader did not return app_id and app_secret');
  }

  return { appId, appSecret };
}

