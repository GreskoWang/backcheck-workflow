import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// Project-local pinned dependency, independent of the selected Node executable.
export const packageRoot = path.resolve(process.env.FEISHU_MCP_PACKAGE_ROOT ||
  path.join(here, '..', 'node_modules', '@larksuiteoapi', 'lark-mcp'));
export const cliPath = path.join(packageRoot, 'dist', 'cli.js');
export const requireLark = createRequire(path.join(packageRoot, 'package.json'));
export const loadMcpClient = async () => ({
  Client: (await import('@modelcontextprotocol/sdk/client/index.js')).Client,
  StdioClientTransport: (await import('@modelcontextprotocol/sdk/client/stdio.js')).StdioClientTransport,
});
