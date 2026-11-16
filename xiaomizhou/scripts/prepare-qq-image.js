import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'qq-runtime.lock.json')));
const arch = process.env.QQ_BUILD_ARCH || ({ x64: 'amd64', arm64: 'arm64' }[process.arch]);
const input = lock.images[arch];
if (!input) throw new Error('No locked QQ source image for this architecture');
const output = path.resolve(process.env.QQ_DOWNLOAD_DIR || path.join(root, 'data/build-inputs'));
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, `napcat-docker-v${lock.qqArchiveVersion}-${arch}.tar`);
const digest = async file => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
if (!fs.existsSync(file) || fs.statSync(file).size !== input.size || await digest(file) !== input.sha256) {
  console.error(`Downloading pinned Linux QQ source archive ${lock.qqArchiveVersion} ${arch} (SHA-256 pinned)`);
  const response = await fetch(input.url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw new Error(`Archived runtime download HTTP ${response.status}`);
  const temporary = `${file}.part`;
  const stream = fs.createWriteStream(temporary);
  const hash = crypto.createHash('sha256'); let size = 0; let last = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > input.size) throw new Error('Archived runtime exceeds locked size');
      hash.update(chunk);
      if (!stream.write(chunk)) await once(stream, 'drain');
      if (Date.now() - last > 5000) { console.error(`Downloaded ${Math.floor(size / 1048576)} / ${Math.ceil(input.size / 1048576)} MiB`); last = Date.now(); }
    }
    stream.end(); await once(stream, 'finish');
    if (size !== input.size || hash.digest('hex') !== input.sha256) throw new Error('Archived runtime failed SHA-256 verification');
    fs.renameSync(temporary, file);
  } catch (error) { stream.destroy(); fs.rmSync(temporary, { force: true }); throw error; }
}
if (process.argv.includes('--download-only')) { console.log(file); process.exit(0); }
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || 'unknown error'}`);
  return result.stdout;
};
const manifests = JSON.parse(run('tar', ['-xOf', file, 'manifest.json']));
if (!Array.isArray(manifests) || manifests.length !== 1 || !manifests[0].Config) throw new Error('Archived image manifest is not supported');
const configName = manifests[0].Config;
if (configName.startsWith('-') || configName.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(configName)) throw new Error('Invalid archived image config path');
const config = run('tar', ['-xOf', file, configName]);
const imageId = `sha256:${crypto.createHash('sha256').update(config).digest('hex')}`;
const tag = `xiaomizhou/qq-runtime:${lock.qqVersion}-${arch}`;
run('docker', ['load', '--input', file]);
// A Docker daemon using the containerd image store may expose the OCI manifest
// digest instead of its config digest as the image ID. Prefer the archive's tag.
const sourceTag = manifests[0].RepoTags?.[0];
if (sourceTag && !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(sourceTag)) throw new Error('Invalid archived image tag');
run('docker', ['tag', sourceTag || imageId, tag]);
console.log(tag);
