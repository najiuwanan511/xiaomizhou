import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkUpdate, compareVersions, installUpdate, runtimeFiles, validateBundle } from '../update-manager.js';

const pkg = { name: 'xiaomizhou', version: '0.2.0', dependencies: { 'fast-xml-parser': '5.11.2' } };
function bundle(version = '0.3.0', dependencies = pkg.dependencies) {
  const files = Object.fromEntries(runtimeFiles.map(name => [name, Buffer.from(name === 'package.json' ? JSON.stringify({ ...pkg, version, dependencies }) : `file:${name}`).toString('base64')]));
  return JSON.stringify({ format: 1, version, files });
}
function mockFetch(raw, hash = crypto.createHash('sha256').update(raw).digest('hex')) {
  return async url => {
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v0.3.0', assets: [{ name: 'xiaomizhou-v0.3.0.json' }, { name: 'xiaomizhou-v0.3.0.json.sha256' }], body: 'Release notes', published_at: '2026-09-30T00:00:00Z' }));
    if (url.endsWith('.sha256')) return new Response(`${hash}  xiaomizhou-v0.3.0.json\n`);
    return new Response(raw);
  };
}

test('release metadata and versions', async () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal((await checkUpdate('0.2.0', mockFetch(bundle()))).available, true);
  assert.equal((await checkUpdate('0.3.0', mockFetch(bundle()))).available, false);
  await assert.rejects(checkUpdate('0.2.0', async () => new Response(JSON.stringify({ tag_name: 'v0.3.0', assets: [] }))), /incomplete/);
});

test('bundle rejects extra files, changed dependencies, and mismatched version', () => {
  assert.equal(validateBundle(bundle(), pkg, '0.3.0').size, runtimeFiles.length);
  const extra = JSON.parse(bundle()); extra.files['../outside'] = 'eA==';
  assert.throws(() => validateBundle(JSON.stringify(extra), pkg, '0.3.0'), /file list/);
  assert.throws(() => validateBundle(bundle('0.3.0', { other: '1' }), pkg, '0.3.0'), /Dependencies changed/);
  const engineChange = JSON.parse(bundle());
  engineChange.files['package.json'] = Buffer.from(JSON.stringify({ ...pkg, version: '0.3.0', engines: { node: '>=26' } })).toString('base64');
  assert.throws(() => validateBundle(JSON.stringify(engineChange), pkg, '0.3.0'), /Node requirements changed/);
  assert.throws(() => validateBundle(bundle('0.4.0'), pkg, '0.3.0'), /Invalid release bundle/);
});

test('install verifies checksum, backs up data, and switches version only on success', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomizhou-update-'));
  const root = path.join(directory, 'app'), dataDir = path.join(directory, 'data');
  fs.mkdirSync(root); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const raw = bundle();
  const backups = [];
  const options = { currentVersion: '0.2.0', root, dataDir, backup: async target => { backups.push(target); fs.writeFileSync(target, 'snapshot'); } };
  try {
    await assert.rejects(installUpdate({ ...options, fetcher: mockFetch(raw, '0'.repeat(64)) }), /checksum mismatch/);
    await assert.rejects(installUpdate({ ...options, expectedVersion: '0.4.0', fetcher: mockFetch(raw) }), /newer release appeared/);
    assert.equal(backups.length, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'releases', 'current.json')), false);
    await installUpdate({ ...options, fetcher: mockFetch(raw) });
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(backups[0], 'utf8'), 'snapshot');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'releases', 'current.json'), 'utf8')).version, '0.3.0');
    assert.equal(fs.readFileSync(path.join(dataDir, 'releases', 'v0.3.0', 'server.js'), 'utf8'), 'file:server.js');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('launcher restores the image version when a pending release cannot start', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomizhou-launcher-'));
  const releaseDir = path.join(dataDir, 'releases', 'v0.3.0');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'server.js'), 'process.exit(1);');
  fs.writeFileSync(path.join(dataDir, 'releases', 'current.json'), JSON.stringify({ version: '0.3.0', previousVersion: '0.2.0', pending: true }));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['launcher.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  try {
    let boot;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { boot = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const runningVersion = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
    assert.equal(boot?.version, runningVersion);
    assert.equal(fs.existsSync(path.join(dataDir, 'releases', 'current.json')), false);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
