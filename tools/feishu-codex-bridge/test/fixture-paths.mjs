import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Strings for mocked calls only. Tests that write files use mkdtemp themselves.
export const fixturePath = (...parts) => path.join(os.tmpdir(), 'backcheck-fixture', ...parts);
export const fixtureFileUrl = (...parts) => pathToFileURL(fixturePath(...parts)).href;
// Exercise Windows separators and paths containing spaces on every host.
// This fictional drive is never opened and contains no developer-machine data.
export const windowsFixturePath = (...parts) => path.win32.join('Z:', path.win32.sep, 'fixture', ...parts);
