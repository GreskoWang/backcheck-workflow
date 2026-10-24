import crypto from 'node:crypto';

const value = process.argv[2] || '';
process.stdout.write(`ARGV_DIGEST_JSON:${JSON.stringify({
  utf16Units: value.length,
  sha256: crypto.createHash('sha256').update(value, 'utf8').digest('hex'),
})}\n`);
