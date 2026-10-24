import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [bridgeRoot, instanceLockModulePath, shutdownControlModulePath] = process.argv.slice(2);
if (!bridgeRoot || !instanceLockModulePath || !shutdownControlModulePath) {
  throw new Error('bridge root and module paths are required');
}

const { acquireInstanceLock } = await import(pathToFileURL(instanceLockModulePath).href);
const { ShutdownControlServer, shutdownControlPath } = await import(
  pathToFileURL(shutdownControlModulePath).href
);

const stateDir = path.join(bridgeRoot, 'state');
const pidPath = path.join(stateDir, 'bridge.pid');
const lockPath = path.join(stateDir, 'bridge.instance.lock');
const stoppedMarkerPath = path.join(stateDir, 'graceful-stop-complete.json');
fs.mkdirSync(stateDir, { recursive: true });

const lock = acquireInstanceLock(lockPath, { legacyPidPath: pidPath });
fs.writeFileSync(pidPath, `${process.pid}\n`, 'utf8');

let stopping = false;
const server = new ShutdownControlServer({
  pipePath: shutdownControlPath(bridgeRoot),
  pid: process.pid,
  token: lock.token,
  async onShutdown(signal) {
    if (stopping) return;
    stopping = true;
    await server.close();
    const currentPid = fs.readFileSync(pidPath, 'utf8').trim();
    if (currentPid === String(process.pid)) fs.rmSync(pidPath);
    if (!lock.release()) throw new Error('fixture lost instance lock ownership');
    fs.writeFileSync(stoppedMarkerPath, `${JSON.stringify({ signal, pid: process.pid })}\n`, 'utf8');
    process.exit(0);
  },
});

await server.start();
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);

const forceCleanup = async () => {
  try { await server.close(); } catch {}
  try {
    if (fs.readFileSync(pidPath, 'utf8').trim() === String(process.pid)) fs.rmSync(pidPath);
  } catch {}
  try { lock.release(); } catch {}
  process.exit(2);
};
process.on('SIGINT', () => void forceCleanup());
process.on('SIGTERM', () => void forceCleanup());

