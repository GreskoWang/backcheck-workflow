import fs from 'node:fs';
import path from 'node:path';

const [bridgeRoot] = process.argv.slice(2);
if (!bridgeRoot) throw new Error('bridge root is required');
const stateDir = path.join(bridgeRoot, 'state');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'bridge.pid'), `${process.pid}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, legacy: true })}\n`);
setInterval(() => {}, 1000);

