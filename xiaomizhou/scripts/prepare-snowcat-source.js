import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'napcat-runtime.lock.json'), 'utf8')).snowcat;
const output = path.resolve(process.argv[2] || path.join(root, 'data/snowcat-source'));
if (fs.existsSync(output)) throw new Error('源码输出目录已存在，请使用新的构建目录');
fs.mkdirSync(path.dirname(output), { recursive: true });
const archive = `${output}.tar.gz`;
const response = await fetch(lock.url, { signal: AbortSignal.timeout(300000), redirect: 'error' });
if (!response.ok) throw new Error(`SnowCat 源码下载 HTTP ${response.status}`);
let size = 0;
const hash = crypto.createHash('sha256');
try {
  await pipeline(response.body, new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > lock.size) return callback(new Error('SnowCat 源码超出锁定大小'));
    hash.update(chunk); callback(null, chunk);
  } }), fs.createWriteStream(archive));
  if (size !== lock.size || hash.digest('hex') !== lock.sha256) throw new Error('SnowCat 源码 SHA-256 校验失败');
  fs.mkdirSync(output);
  const result = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', output], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('SnowCat 源码解压失败');
} finally { fs.rmSync(archive, { force: true }); }
console.log(`SnowCat source verified: ${lock.commit}`);
