import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const releaseRepo = 'najiuwanan511/xiaomizhou';
export const runtimeFiles = [
  'package.json', 'server.js', 'plugin-runner.js', 'qq-bridge.js',
  'qqbot-bridge.js', 'wecom-bridge.js', 'rebate-automation.js', 'ai-brain.js',
  'update-manager.js', 'public/index.html', 'public/app.js', 'public/style.css',
  'public/lucide.min.js', 'public/LUCIDE-LICENSE.txt'
];
const maxBytes = 5 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+$/;

export function compareVersions(a, b) {
  if (!versionPattern.test(a) || !versionPattern.test(b)) throw new Error('Invalid release version');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

async function limitedText(url, fetcher, limit = maxBytes) {
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xiaomizhou-updater' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Release file exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function checkUpdate(currentVersion, fetcher = fetch) {
  const release = JSON.parse(await limitedText(`https://api.github.com/repos/${releaseRepo}/releases/latest`, fetcher, 512 * 1024));
  const tag = String(release.tag_name || '');
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  if (!versionPattern.test(version) || release.draft || release.prerelease) throw new Error('No stable release available');
  const file = `xiaomizhou-v${version}.json`;
  const checksum = `${file}.sha256`;
  if (![file, checksum].every(name => release.assets?.some(asset => asset.name === name))) throw new Error('Release assets are incomplete');
  return {
    currentVersion, latestVersion: version, available: compareVersions(version, currentVersion) > 0,
    notes: String(release.body || '').slice(0, 12000), publishedAt: release.published_at,
    url: `https://github.com/${releaseRepo}/releases/tag/${tag}`
  };
}

export function validateBundle(raw, currentPackage, expectedVersion) {
  const bundle = JSON.parse(raw);
  if (bundle.format !== 1 || bundle.version !== expectedVersion || !versionPattern.test(bundle.version)) throw new Error('Invalid release bundle');
  if (!bundle.files || Object.keys(bundle.files).length !== runtimeFiles.length ||
      !runtimeFiles.every(name => typeof bundle.files[name] === 'string')) throw new Error('Release file list is invalid');
  const files = new Map();
  for (const name of runtimeFiles) {
    const encoded = bundle.files[name];
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error(`Invalid file encoding: ${name}`);
    files.set(name, Buffer.from(encoded, 'base64'));
  }
  const nextPackage = JSON.parse(files.get('package.json').toString('utf8'));
  if (nextPackage.name !== 'xiaomizhou' || nextPackage.version !== expectedVersion) throw new Error('Package version mismatch');
  if (JSON.stringify(nextPackage.dependencies || {}) !== JSON.stringify(currentPackage.dependencies || {})) throw new Error('Dependencies changed; rebuild the Docker image to upgrade');
  if (JSON.stringify(nextPackage.engines || {}) !== JSON.stringify(currentPackage.engines || {})) throw new Error('Node requirements changed; rebuild the Docker image to upgrade');
  return files;
}

export async function installUpdate({ currentVersion, expectedVersion, root, dataDir, backup, fetcher = fetch }) {
  const info = await checkUpdate(currentVersion, fetcher);
  if (!info.available) throw new Error('Already on the latest version');
  if (expectedVersion && info.latestVersion !== expectedVersion) throw new Error('A newer release appeared; check for updates again');
  const version = info.latestVersion;
  const file = `xiaomizhou-v${version}.json`;
  const base = `https://github.com/${releaseRepo}/releases/download/v${version}/`;
  const checksumText = await limitedText(base + file + '.sha256', fetcher, 256);
  const expectedHash = new RegExp(`^([a-f0-9]{64})  ${file.replaceAll('.', '\\.')}$`).exec(checksumText.trim())?.[1];
  if (!expectedHash) throw new Error('Invalid release checksum');
  const raw = await limitedText(base + file, fetcher);
  if (crypto.createHash('sha256').update(raw).digest('hex') !== expectedHash) throw new Error('Release checksum mismatch');
  const currentPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = validateBundle(raw, currentPackage, version);
  const releases = path.join(dataDir, 'releases');
  const destination = path.join(releases, `v${version}`);
  const stage = fs.mkdtempSync(path.join(dataDir, '.update-'));
  try {
    for (const [name, content] of files) {
      const target = path.join(stage, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { flag: 'wx' });
    }
    fs.mkdirSync(releases, { recursive: true });
    if (fs.existsSync(destination)) throw new Error('Release already staged; resolve it before retrying');
    await backup(path.join(releases, `before-v${version}-${Date.now()}.db`));
    try {
      fs.renameSync(stage, destination);
      const pointer = path.join(releases, 'current.json');
      const temporary = path.join(releases, `current-${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify({ version, previousVersion: currentVersion, pending: true }));
        fs.renameSync(temporary, pointer);
      } finally { fs.rmSync(temporary, { force: true }); }
    } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
    return info;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
