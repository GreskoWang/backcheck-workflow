import path from 'node:path';

export function windowsSystemPath(...parts) {
  return systemPathFromEnv(process.env, ...parts);
}

export function systemPathFromEnv(env, ...parts) {
  const root = env.SystemRoot || env.WINDIR || env.windir;
  if (!root || !path.win32.isAbsolute(root)) {
    const error = new Error('SystemRoot/WINDIR must identify the Windows installation before ACL tools can run.');
    error.code = 'acl_tool_missing';
    throw error;
  }
  return path.win32.join(root, 'System32', ...parts);
}
