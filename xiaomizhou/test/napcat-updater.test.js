import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createNapcatUpdater, extractNapcatZip, readNapcatUpdateStatus, napcatUpdateRepo } from '../napcat-updater.js';

// A real stored ZIP with central-directory attributes, including malicious cases.
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, value, mode = 0o100644] of entries) {
    const filename = Buffer.from(name), body = Buffer.from(value);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(body), 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(body), 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(body.length, 24); record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((mode * 65536) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, filename, body); central.push(record, filename); offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const files = ['napcat.mjs', 'package.json', 'node_modules/express/package.json', 'node_modules/ws/package.json', 'native/packet/MoeHoo.linux.x64.node', 'static/index.html'];
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmz-napcat-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), baseDir = path.join(root, 'base');
  for (const name of files) { const file = path.join(baseDir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}'); }
  fs.mkdirSync(path.join(dataDir, 'napcat/config'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'napcat/config/webui.json'), '{"account":"12345"}');
  fs.mkdirSync(path.join(dataDir, 'qq-home'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'qq-home/session'), 'login-data');
  const bytes = options.bytes || zip(files.map(name => [name, '{}']));
  const version = options.version || '4.18.43';
  const assetUrl = `https://github.com/${napcatUpdateRepo}/releases/download/v${version}/NapCat.Shell.zip`;
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url === assetUrl) return new Response(bytes);
    assert.equal(url, `https://api.github.com/repos/${napcatUpdateRepo}/releases/latest`);
    return Response.json({ tag_name: `v${version}`, assets: [{ name: 'NapCat.Shell.zip', size: bytes.length, browser_download_url: assetUrl, digest: `sha256:${options.hash || crypto.createHash('sha256').update(bytes).digest('hex')}` }] });
  };
  const transitions = [];
  const args = { dataDir, baseDir, baseVersion: '4.18.42', arch: 'x64', fetcher, stopRuntime: async () => transitions.push('stop'), startRuntime: async dir => { transitions.push(dir); options.onStart?.(dir, dataDir); }, healthy: options.healthy || (async () => true) };
  return { dataDir, baseDir, transitions, calls, args, updater: createNapcatUpdater(args) };
}

test('NapCat downloads a verified full payload, switches only the core, and can restore the previous core and config', async t => {
  const fixture = setup(t, { onStart(dir, data) { if (dir.endsWith('v4.18.43')) fs.writeFileSync(path.join(data, 'napcat/config/webui.json'), '{"migrated":true}'); } });
  const { updater, dataDir, baseDir, transitions } = fixture;
  const checked = await updater.run('check');
  assert.equal(checked.latestVersion, '4.18.43'); assert.equal(checked.available, true);
  const installed = await updater.run('install', checked.latestVersion);
  assert.equal(installed.state, 'installed'); assert.equal(installed.currentVersion, '4.18.43'); assert.equal(installed.canRollback, true);
  assert.equal(transitions.length, 2);
  assert.equal(fs.readFileSync(path.join(dataDir, 'qq-home/session'), 'utf8'), 'login-data');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'napcat-releases/current.json'))).pending, undefined);
  assert.equal(createNapcatUpdater(fixture.args).selectedDirectory(), updater.selectedDirectory());
  const result = await updater.run('rollback');
  assert.equal(result.state, 'rolled-back'); assert.equal(result.currentVersion, '4.18.42');
  assert.equal(updater.selectedDirectory(), baseDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'napcat/config/webui.json'))).account, '12345');
  assert.equal(transitions.at(-1), baseDir);
});

test('startup failure restores the previous payload and pre-migration config automatically', async t => {
  let checks = 0;
  const { updater, transitions, dataDir, baseDir } = setup(t, { healthy: async () => ++checks > 1, onStart(dir, data) { if (dir.endsWith('v4.18.43')) fs.writeFileSync(path.join(data, 'napcat/config/webui.json'), 'incompatible'); } });
  const result = await updater.run('install', '4.18.43');
  assert.equal(result.state, 'rolled-back'); assert.equal(result.currentVersion, '4.18.42');
  assert.match(result.message, /未通过/); assert.equal(transitions.at(-1), baseDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'napcat/config/webui.json'))).account, '12345');
});

test('checksum failure and stale requests do not stop the running core', async t => {
  const { updater, transitions } = setup(t, { hash: '0'.repeat(64) });
  assert.match((await updater.run('install', '4.18.44')).message, /重新检查/);
  const result = await updater.run('install', '4.18.43');
  assert.equal(result.state, 'error'); assert.match(result.message, /SHA-256/);
  assert.deepEqual(transitions, []);
});

test('major upgrades require a complete image and a concurrent task cannot restart a switching core', async t => {
  const { updater, transitions } = setup(t, { version: '5.0.0' });
  const pending = updater.run('check');
  await assert.rejects(updater.run('install', '5.0.0'), /正在进行/);
  assert.equal((await pending).compatible, false);
  assert.match((await updater.run('install', '5.0.0')).message, /完整小米粥镜像/);
  assert.deepEqual(transitions, []);
});

test('interrupted update restores its saved version and configuration on launcher recovery', async t => {
  const { dataDir, args, baseDir } = setup(t);
  const releases = path.join(dataDir, 'napcat-releases');
  const backup = 'backup-00000000-0000-0000-0000-000000000001';
  fs.mkdirSync(path.join(releases, backup, 'config'), { recursive: true });
  fs.writeFileSync(path.join(releases, backup, 'config/webui.json'), '{"account":"old"}');
  fs.writeFileSync(path.join(releases, 'current.json'), JSON.stringify({ version: '4.18.43', previous: '4.18.42', backup, pending: true, baseVersion: '4.18.42', arch: 'x64' }));
  const recovered = createNapcatUpdater(args);
  assert.equal(recovered.selectedDirectory(), baseDir);
  assert.equal(readNapcatUpdateStatus(dataDir).state, 'rolled-back');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'napcat/config/webui.json'))).account, 'old');
});

test('ZIP traversal, symlinks, duplicate members and incomplete payloads are rejected before switching', async t => {
  for (const entries of [[['../escape', 'bad']], [['link', '../escape', 0o120777]], [['a', 'one'], ['a', 'two']], [['napcat.mjs', 'only-partial']]]) {
    const { updater, transitions } = setup(t, { bytes: zip(entries) });
    const result = await updater.run('install', '4.18.43');
    assert.equal(result.state, 'error', JSON.stringify(entries));
    assert.deepEqual(transitions, []);
  }
});

test('process termination during manual rollback restores the pre-rollback core and config on next launch', async t => {
  const { updater, dataDir, baseDir, args } = setup(t);
  assert.equal((await updater.run('install', '4.18.43')).state, 'installed');
  const configDir = path.join(dataDir, 'napcat/config');
  fs.writeFileSync(path.join(configDir, 'webui.json'), '{"account":"current-session"}');
  const pointer = path.join(dataDir, 'napcat-releases/current.json');
  const installed = JSON.parse(fs.readFileSync(pointer));
  const source = path.join(dataDir, 'napcat-releases', installed.backup, 'config');
  const script = `
    import fs from 'node:fs';
    import {createNapcatUpdater} from ${JSON.stringify(new URL('../napcat-updater.js', import.meta.url).href)};
    const copy = fs.cpSync;
    fs.cpSync = (from, ...rest) => {
      if (from === ${JSON.stringify(source)}) process.exit(77);
      return copy(from, ...rest);
    };
    const updater = createNapcatUpdater({dataDir:${JSON.stringify(dataDir)},baseDir:${JSON.stringify(baseDir)},arch:'x64',stopRuntime:async()=>{},startRuntime:async()=>{},healthy:async()=>true});
    await updater.run('rollback');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  assert.equal((await once(child, 'exit'))[0], 77);
  assert.equal(JSON.parse(fs.readFileSync(pointer)).pending, true);
  const recovered = createNapcatUpdater(args);
  assert.equal(path.basename(recovered.selectedDirectory()), 'v4.18.43');
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'webui.json'))).account, 'current-session');
  assert.equal(readNapcatUpdateStatus(dataDir).state, 'rolled-back');
  assert.equal(JSON.parse(fs.readFileSync(pointer)).pending, undefined);
  assert.equal(fs.readFileSync(path.join(dataDir, 'qq-home/session'), 'utf8'), 'login-data');
});
