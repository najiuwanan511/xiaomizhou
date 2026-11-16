import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNapcatManager, parseNapcatConfig } from '../napcat-manager.js';
import { prepareBundledRuntime } from '../bundled-runtime.js';
import { startNapcatMock } from '../napcat-mock.fixture.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

async function backend(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomizhou-snowcat-api-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env } });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (url, method = 'GET', payload) => {
    const response = await fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  for (let i = 0; i < 100; i++) {
    try { await request('/api/bootstrap'); break; } catch { await new Promise(resolve => setTimeout(resolve, 40)); }
  }
  assert.equal((await request('/api/setup', 'POST', { username: 'admin', password: 'snowcat-test-password' })).status, 200);
  return { request, child };
}

test('changing the external framework disables the old OneBot sender before new wiring', async t => {
  const mock = await startNapcatMock(); t.after(mock.close); mock.state.loggedIn = true;
  const { request } = await backend(t);
  const config = { framework: 'napcat', webuiUrl: mock.base, webuiToken: mock.state.token, onebotUrl: mock.base, callbackBaseUrl: 'http://localhost:8090' };
  assert.equal((await request('/api/napcat', 'PUT', config)).status, 200);
  assert.equal((await request('/api/napcat/connect', 'POST')).status, 200);
  assert.equal((await request('/api/qq')).data.enabled, true);
  assert.equal((await request('/api/napcat', 'PUT', { ...config, framework: 'snowcat', webuiToken: '********' })).status, 400);
  assert.equal((await request('/api/qq')).data.enabled, true, 'failed changes cannot disrupt the current sender');
  assert.equal((await request('/api/napcat', 'PUT', { ...config, framework: 'snowcat' })).status, 200);
  assert.equal((await request('/api/qq')).data.enabled, false);
  assert.equal((await request('/api/napcat/status')).data.framework, 'snowcat');
  assert.equal((await request('/api/napcat/connect', 'POST')).status, 200);
  assert.equal((await request('/api/napcat/status')).data.messageConnected, true);
});

test('bundled SnowCat rejects NapCat updates while preserving runtime restart control', async t => {
  const { request, child } = await backend(t, { NAPCAT_BUNDLED: '1', QQ_FRAMEWORK: 'snowcat' });
  const config = (await request('/api/napcat')).data;
  assert.equal(config.framework, 'snowcat'); assert.equal(config.bundled, true);
  assert.equal((await request('/api/napcat', 'PUT', {})).status, 409);
  for (const [url, method] of [['/api/napcat/updates', 'GET'], ['/api/napcat/updates/check', 'POST'], ['/api/napcat/updates/install', 'POST'], ['/api/napcat/updates/rollback', 'POST']]) {
    assert.equal((await request(url, method, method === 'POST' ? {} : undefined)).status, 409);
  }
  const message = once(child, 'message');
  assert.equal((await request('/api/napcat/restart', 'POST', {})).status, 202);
  assert.equal((await message)[0].type, 'napcat-restart');
});

test('framework selection validates identity and requires a fresh secret when switching', () => {
  assert.equal(parseNapcatConfig({}).framework, 'napcat');
  assert.equal(parseNapcatConfig({ framework: 'snowcat' }).framework, 'snowcat');
  assert.throws(() => parseNapcatConfig({ framework: '../other' }), /只支持/);
  assert.throws(() => parseNapcatConfig({ framework: 'snowcat', webuiToken: '********' }, { webuiToken: 'napcat-secret' }), /新框架/);
});

test('SnowCat phases hide stale QR and prevent wiring before core readiness', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  let config = { framework: 'snowcat', webuiUrl: mock.base, webuiToken: mock.state.token, onebotUrl: mock.base, callbackBaseUrl: 'http://localhost:8090' };
  let qq = {};
  const manager = createNapcatManager({ getConfig: () => config, getQqConfig: () => qq });
  assert.match((await manager.status()).qrCode, /^data:image\/png/);
  for (const phase of ['qrcode_scanned', 'initializing', 'offline', 'reconnecting']) {
    mock.state.phase = phase;
    mock.state.loggedIn = phase === 'initializing';
    const status = await manager.status();
    assert.equal(status.framework, 'snowcat');
    assert.equal(status.state, ['offline', 'reconnecting'].includes(phase) ? 'offline' : 'initializing');
    assert.equal(status.qrCode, null);
    await assert.rejects(manager.connect('secret', () => assert.fail('not ready')), error => error.status === 409);
  }
  mock.state.phase = 'ready'; mock.state.loggedIn = true;
  await manager.connect('callback-secret', saved => { qq = saved; });
  assert.equal(qq.framework, 'snowcat');
  assert.equal((await manager.status()).messageConnected, true);
  assert.equal(mock.state.config.network.httpClients.length, 1);
  const logins = mock.state.logins;
  config = { ...config, framework: 'napcat' };
  await manager.status();
  assert.equal(mock.state.logins, logins + 1, 'credentials cannot be shared across frameworks');
});

test('unusable SnowCat credentials and two-factor login do not cause a login storm or expose secrets', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  const config = { framework: 'snowcat', webuiUrl: mock.base, webuiToken: mock.state.token };
  const manager = createNapcatManager({ getConfig: () => config, getQqConfig: () => ({}) });
  mock.state.rejectCredentials = Infinity;
  const broken = await manager.status();
  assert.equal(broken.state, 'auth-error');
  assert.match(broken.error, /SnowCat/);
  assert.ok(!JSON.stringify(broken).includes(mock.state.token));
  const logins = mock.state.logins;
  await manager.status(); await manager.status();
  assert.equal(mock.state.logins, logins);
  mock.state.require2FA = true; manager.clear();
  assert.match((await manager.status()).error, /两步验证/);
  await manager.status();
  assert.equal(mock.state.logins, logins + 1);
});

test('bundled frameworks isolate config, secrets, saved login and runtime state for rollback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomizhou-framework-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime'), qqDir = path.join(root, 'QQ'), dataDir = path.join(root, 'data');
  for (const file of ['napcat.mjs', 'node_modules/express/package.json']) {
    const target = path.join(runtimeDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '{}');
  }
  for (const file of ['qq', 'resources/app/package.json', 'resources/app/wrapper.node']) {
    const target = path.join(qqDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '{}');
  }
  const options = { runtimeDir, qqDir, dataDir, appPort: 8090 };
  const original = prepareBundledRuntime(options);
  const snowcat = prepareBundledRuntime({ ...options, framework: 'snowcat' });
  assert.notEqual(original.env.NAPCAT_WEBUI_TOKEN, snowcat.env.NAPCAT_WEBUI_TOKEN);
  assert.notEqual(original.childEnv.HOME, snowcat.childEnv.HOME);
  assert.notEqual(original.childEnv.NAPCAT_WORKDIR, snowcat.childEnv.NAPCAT_WORKDIR);
  assert.notEqual(original.statusFile, snowcat.statusFile);
  assert.equal(snowcat.childEnv.QQ_FRAMEWORK, 'snowcat');
  assert.equal(snowcat.env.QQ_FRAMEWORK, 'snowcat');
  assert.match(snowcat.childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY, /^[a-f0-9]{64}$/);
  assert.notEqual(snowcat.childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY, snowcat.env.NAPCAT_WEBUI_TOKEN);
  assert.equal(prepareBundledRuntime({ ...options, framework: 'snowcat' }).childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY, snowcat.childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY);
  assert.equal(prepareBundledRuntime(options).env.NAPCAT_WEBUI_TOKEN, original.env.NAPCAT_WEBUI_TOKEN);
});
