import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OWNER_FILE = 'owner.json';
const DEFAULT_INITIALIZATION_GRACE_MS = 30_000;
const MAX_ACQUIRE_ATTEMPTS = 8;

export class InstanceLockError extends Error {
  constructor(message, { code = 'INSTANCE_LOCKED', owner = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InstanceLockError';
    this.code = code;
    this.owner = owner;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this account may not signal it.
    return error?.code === 'EPERM';
  }
}

function inspectWindowsProcess(pid) {
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; ` +
    `if ($p) { [pscustomobject]@{ name = $p.Name; commandLine = $p.CommandLine; ` +
    `createdAtMs = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new InstanceLockError('cannot verify process identity before reclaiming a lock', {
      code: 'INSTANCE_IDENTITY_UNVERIFIED', cause: result.error,
    });
  }
  const output = result.stdout.trim();
  if (!output) return null;
  try { return JSON.parse(output); }
  catch (error) {
    throw new InstanceLockError('process identity response is invalid', {
      code: 'INSTANCE_IDENTITY_UNVERIFIED', cause: error,
    });
  }
}

function exactEntryArgument(commandLine, entryPath) {
  const escaped = entryPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s)(?:"${escaped}"|${escaped})(?=\\s|$)`, 'iu')
    .test(String(commandLine || ''));
}

function verifiedBridgeProcess(pid, entryPath, ownerCreatedAt, inspectProcess) {
  const info = inspectProcess(pid);
  if (!info) return false;
  if (String(info.name || '').toLowerCase() !== 'node.exe') return false;
  if (typeof info.commandLine !== 'string' || !Number.isSafeInteger(info.createdAtMs)) {
    throw new InstanceLockError('process identity is incomplete', {
      code: 'INSTANCE_IDENTITY_UNVERIFIED',
    });
  }
  if (!exactEntryArgument(info.commandLine, entryPath)) return false;
  if (ownerCreatedAt) {
    const lockTime = Date.parse(ownerCreatedAt);
    if (!Number.isFinite(lockTime)) {
      throw new InstanceLockError('instance lock creation time is invalid', {
        code: 'INSTANCE_IDENTITY_UNVERIFIED',
      });
    }
    return info.createdAtMs <= lockTime + 1000;
  }
  return true;
}

export function acquireInstanceLock(lockPath, options = {}) {
  const resolvedLockPath = path.resolve(String(lockPath || ''));
  if (!lockPath || resolvedLockPath === path.parse(resolvedLockPath).root) {
    throw new TypeError('instance lock path must name a non-root path');
  }

  const pid = options.pid ?? process.pid;
  const token = String(options.token || crypto.randomUUID());
  const legacyPidPath = options.legacyPidPath
    ? path.resolve(String(options.legacyPidPath))
    : null;
  const processAlive = options.isProcessAlive || isProcessAlive;
  const entryPath = options.entryPath ? path.resolve(String(options.entryPath)) : null;
  const inspectProcess = options.inspectProcess || inspectWindowsProcess;
  const ownerIsAlive = options.isOwnerProcess || (entryPath
    ? (owner) => verifiedBridgeProcess(owner.pid, entryPath, owner.createdAt, inspectProcess)
    : (owner) => processAlive(owner.pid));
  const beforeOwnerWrite = options.beforeOwnerWrite;
  const initializationGraceMs = options.initializationGraceMs
    ?? DEFAULT_INITIALIZATION_GRACE_MS;

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError('instance lock pid must be a positive integer');
  }
  if (!token) throw new TypeError('instance lock token must not be empty');
  if (!Number.isFinite(initializationGraceMs) || initializationGraceMs < 0) {
    throw new TypeError('initializationGraceMs must be a non-negative number');
  }
  if (beforeOwnerWrite !== undefined && typeof beforeOwnerWrite !== 'function') {
    throw new TypeError('beforeOwnerWrite must be a function');
  }

  fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      fs.mkdirSync(resolvedLockPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      const existing = readOwner(resolvedLockPath);
      if (existing.owner && ownerIsAlive(existing.owner)) {
        throw lockedError(resolvedLockPath, existing.owner);
      }
      if (!existing.owner && lockDirectoryIsInitializing(
        resolvedLockPath,
        initializationGraceMs,
      )) {
        throw new InstanceLockError(
          `instance lock is being initialized: ${resolvedLockPath}`,
          { code: 'INSTANCE_LOCK_INITIALIZING' },
        );
      }

      const reclaimed = reclaimDeadLock(
        resolvedLockPath,
        existing.owner?.token || null,
        ownerIsAlive,
      );
      if (reclaimed) continue;
      continue;
    }

    const owner = {
      pid,
      token,
      createdAt: new Date().toISOString(),
    };
    try {
      beforeOwnerWrite?.({ lockPath: resolvedLockPath, owner: { ...owner } });
      writeOwner(resolvedLockPath, owner);
    } catch (error) {
      // The canonical directory may have been reclaimed and replaced while an
      // initializer was paused. Never delete it here without a verified token.
      throw error;
    }

    const lock = createLockHandle(resolvedLockPath, owner);
    try {
      assertNoLiveLegacyOwner(legacyPidPath, pid, processAlive, entryPath, inspectProcess);
    } catch (error) {
      lock.release();
      throw error;
    }
    return lock;
  }

  throw new InstanceLockError(
    `instance lock changed repeatedly while acquiring: ${resolvedLockPath}`,
    { code: 'INSTANCE_LOCK_RACE' },
  );
}

function readOwner(lockPath) {
  const ownerPath = path.join(lockPath, OWNER_FILE);
  try {
    const value = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    const pid = Number(value?.pid);
    const token = typeof value?.token === 'string' ? value.token.trim() : '';
    if (!Number.isSafeInteger(pid) || pid <= 0 || !token) {
      return { owner: null, reason: 'invalid' };
    }
    return {
      owner: {
        pid,
        token,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
      },
      reason: null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { owner: null, reason: 'missing' };
    if (error instanceof SyntaxError) return { owner: null, reason: 'invalid' };
    throw error;
  }
}

function writeOwner(lockPath, owner) {
  const ownerPath = path.join(lockPath, OWNER_FILE);
  const descriptor = fs.openSync(ownerPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function lockDirectoryIsInitializing(lockPath, graceMs) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs < graceMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function reclaimDeadLock(lockPath, expectedToken, ownerIsAlive) {
  const quarantinePath = siblingPath(lockPath, 'reclaim');
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
    throw error;
  }

  const moved = readOwner(quarantinePath);
  const tokenChanged = expectedToken && moved.owner?.token !== expectedToken;
  let ownerRevived;
  try {
    ownerRevived = moved.owner && ownerIsAlive(moved.owner);
  } catch (error) {
    restoreMovedLock(quarantinePath, lockPath);
    throw error;
  }
  if (tokenChanged || ownerRevived) {
    restoreMovedLock(quarantinePath, lockPath);
    throw lockedError(lockPath, moved.owner);
  }

  removeSiblingDirectory(quarantinePath, lockPath);
  return true;
}

function createLockHandle(lockPath, owner) {
  let released = false;
  return Object.freeze({
    lockPath,
    pid: owner.pid,
    token: owner.token,
    owner: Object.freeze({ ...owner }),
    release() {
      if (released) return false;
      const current = readOwner(lockPath).owner;
      if (!current || current.token !== owner.token) return false;

      const releasePath = siblingPath(lockPath, 'release');
      try {
        fs.renameSync(lockPath, releasePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }

      const moved = readOwner(releasePath).owner;
      if (!moved || moved.token !== owner.token) {
        restoreMovedLock(releasePath, lockPath);
        return false;
      }

      removeSiblingDirectory(releasePath, lockPath);
      released = true;
      return true;
    },
  });
}

function assertNoLiveLegacyOwner(legacyPidPath, ownPid, processAlive, entryPath, inspectProcess) {
  if (!legacyPidPath) return;
  let raw;
  try {
    raw = fs.readFileSync(legacyPidPath, 'utf8').trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new InstanceLockError(
      `legacy pid file is invalid: ${legacyPidPath}`,
      { code: 'LEGACY_PID_INVALID' },
    );
  }
  const legacyPid = Number(raw);
  const anotherBridge = legacyPid !== ownPid && (entryPath
    ? verifiedBridgeProcess(legacyPid, entryPath, null, inspectProcess)
    : processAlive(legacyPid));
  if (anotherBridge) {
    throw new InstanceLockError(
      `legacy bridge process is still running with pid ${legacyPid}`,
      { code: 'LEGACY_INSTANCE_RUNNING', owner: { pid: legacyPid, token: null } },
    );
  }
}

function lockedError(lockPath, owner) {
  const detail = owner?.pid ? ` (pid ${owner.pid})` : '';
  return new InstanceLockError(
    `instance lock is already owned${detail}: ${lockPath}`,
    { owner: owner || null },
  );
}

function siblingPath(lockPath, purpose) {
  return `${lockPath}.${purpose}-${process.pid}-${crypto.randomUUID()}`;
}

function restoreMovedLock(movedPath, lockPath) {
  try {
    fs.renameSync(movedPath, lockPath);
  } catch (error) {
    throw new InstanceLockError(
      `instance lock changed during ownership verification: ${lockPath}`,
      { code: 'INSTANCE_LOCK_RACE', cause: error },
    );
  }
}

function removeSiblingDirectory(targetPath, lockPath) {
  const resolvedTarget = path.resolve(targetPath);
  const expectedParent = path.dirname(path.resolve(lockPath));
  if (path.dirname(resolvedTarget) !== expectedParent) {
    throw new Error(`refusing to remove instance lock outside ${expectedParent}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}
