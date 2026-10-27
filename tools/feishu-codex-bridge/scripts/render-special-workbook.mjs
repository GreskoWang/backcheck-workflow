import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

// This renders an imported copy in memory and never saves or edits the XLSX.
const [inputPath, requestPath, outputDirectory] = process.argv.slice(2);
const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
const runtimeNode = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node');
const require = createRequire(path.join(runtimeNode, 'package.json'));
const modulePath = process.env.SPECIAL_ARTIFACT_TOOL_MODULE || require.resolve('@oai/artifact-tool');
const { FileBlob, SpreadsheetFile } = await import(pathToFileURL(modulePath).href);
if (!Array.isArray(request.ranges) || request.ranges.length === 0 || request.ranges.length > 40) throw new Error('render range limit');
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
await fs.mkdir(outputDirectory, { recursive: true });
const renders = [];
for (const [index, range] of request.ranges.entries()) {
  if (typeof range.sheetName !== 'string' || (range.autoCrop !== 'all' && !/^[A-Z]+[1-9][0-9]*:[A-Z]+[1-9][0-9]*$/u.test(range.range))) throw new Error('invalid render range');
  const blob = await workbook.render({ sheetName: range.sheetName, ...(range.autoCrop === 'all' ? { autoCrop: 'all' } : { range: range.range }), scale: 1, format: 'png' });
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error('render payload limit');
  const output = path.join(outputDirectory, `view-${index + 1}.png`);
  await fs.writeFile(output, bytes);
  renders.push({ id: `view-${index + 1}`, path: output, sheet: range.sheetName, range: range.range, engine: 'artifact-tool',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
process.stdout.write(JSON.stringify({ renders }));
