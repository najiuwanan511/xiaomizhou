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
  return { request, child, dataDir };
}

test('changing the external management connection disables the old OneBot sender before new wiring', async t => {
  const mock = await startNapcatMock(); t.after(mock.close); mock.state.loggedIn = true;
  const { request } = await backend(t);
  const config = { framework: 'snowcat', webuiUrl: mock.base, webuiToken: mock.state.token, onebotUrl: mock.base, callbackBaseUrl: 'http://localhost:8090' };
  assert.equal((await request('/api/napcat', 'PUT', config)).status, 200);
  assert.equal((await request('/api/napcat/connect', 'POST')).status, 200);
  assert.equal((await request('/api/qq')).data.enabled, true);
  assert.equal((await request('/api/napcat', 'PUT', { ...config, framework: 'napcat' })).status, 400);
  assert.equal((await request('/api/qq')).data.enabled, true, 'failed changes cannot disrupt the current sender');
  assert.equal((await request('/api/napcat', 'PUT', { ...config, webuiToken: 'new-secret' })).status, 200);
  assert.equal((await request('/api/qq')).data.enabled, false);
  assert.equal((await request('/api/napcat', 'PUT', config)).status, 200);
  assert.equal((await request('/api/napcat/status')).data.framework, 'snowcat');
  assert.equal((await request('/api/napcat/connect', 'POST')).status, 200);
  assert.equal((await request('/api/napcat/status')).data.messageConnected, true);
});

test('bundled SnowCat rejects NapCat updates while preserving runtime restart control', async t => {
  const { request, child } = await backend(t, { NAPCAT_BUNDLED: '1', QQ_FRAMEWORK: 'snowcat', QQ_KERNEL_CONTROL: '1' });
  const config = (await request('/api/napcat')).data;
  assert.equal(config.framework, 'snowcat'); assert.equal(config.bundled, true);
  assert.equal((await request('/api/napcat', 'PUT', {})).status, 409);
  for (const [url, method] of [['/api/napcat/updates', 'GET'], ['/api/napcat/updates/check', 'POST'], ['/api/napcat/updates/install', 'POST'], ['/api/napcat/updates/rollback', 'POST']]) {
    assert.equal((await request(url, method, method === 'POST' ? {} : undefined)).status, 409);
  }
  child.on('message', msg => {
    if (msg.type === 'qq-kernel-control') child.send({ type: 'qq-kernel-result', id: msg.id, ok: true, enabled: true });
  });
  assert.equal((await request('/api/napcat/restart', 'POST', {})).status, 200);
});

test('only SnowCat can be selected and masked credentials remain stable', () => {
  assert.equal(parseNapcatConfig({}).framework, 'snowcat');
  for (const framework of ['napcat', '../other']) assert.throws(() => parseNapcatConfig({ framework }), error => error.status === 400);
  assert.equal(parseNapcatConfig({ webuiToken: '********' }, { webuiToken: 'saved-secret' }).webuiToken, 'saved-secret');
});

test('kernel API waits for parent results, reports failure and hides stopped login state without upstream calls', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  const { request, child, dataDir } = await backend(t, { NAPCAT_BUNDLED: '1', QQ_KERNEL_CONTROL: '1', NAPCAT_WEBUI_URL: mock.base, NAPCAT_WEBUI_TOKEN: mock.state.token });
  let reject = true, response;
  child.on('message', msg => {
    if (msg.type !== 'qq-kernel-control') return;
    response = () => {
      if (!reject) fs.writeFileSync(path.join(dataDir, 'qq-kernel-control.json'), JSON.stringify({ enabled: msg.action !== 'stop' }));
      child.send({ type: 'qq-kernel-result', id: msg.id, ok: !reject, enabled: msg.action !== 'stop', status: 409, error: '内核正在处理其他操作，请稍后重试' });
    };
    response();
  });
  assert.equal((await request('/api/napcat/stop', 'POST')).status, 409);
  reject = false;
  assert.equal((await request('/api/napcat/stop', 'POST')).data.enabled, false);
  const logins = mock.state.logins;
  const status = (await request('/api/napcat/status')).data;
  assert.equal(status.state, 'stopped'); assert.equal(status.qrCode, null); assert.equal(status.account, null);
  assert.equal(status.autoError, null); assert.equal(status.messageConnected, false);
  assert.equal(mock.state.logins, logins);
  assert.equal((await request('/api/qq')).data.enabled, false);
  assert.equal((await request('/api/napcat/qrcode/refresh', 'POST')).status, 409);
  assert.equal((await request('/api/napcat/connect', 'POST')).status, 409);
  assert.equal((await request('/api/napcat/start', 'POST')).data.enabled, true);
  assert.equal((await request('/api/napcat/status')).data.state, 'waiting');
});

test('old bundled launchers cannot accept unsupported process control', async t => {
  const { request } = await backend(t, { NAPCAT_BUNDLED: '1' });
  assert.equal((await request('/api/napcat')).data.runtimeControl, false);
  for (const action of ['start', 'stop', 'restart']) assert.equal((await request(`/api/napcat/${action}`, 'POST')).status, 409);
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
  config = { ...config, webuiToken: config.webuiToken + '-changed' };
  await manager.status();
  assert.equal(mock.state.logins, logins + 1, 'credentials cannot be shared across management connections');
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

test('SnowCat preserves stable private configuration and leaves historical NapCat data intact', t => {
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
  fs.mkdirSync(dataDir, { recursive: true });
  const historical = path.join(dataDir, 'napcat-private.json'); fs.writeFileSync(historical, 'historical-user-data');
  const original = prepareBundledRuntime(options);
  const snowcat = prepareBundledRuntime({ ...options, framework: 'snowcat' });
  assert.equal(original.env.NAPCAT_WEBUI_TOKEN, snowcat.env.NAPCAT_WEBUI_TOKEN);
  assert.equal(fs.readFileSync(historical, 'utf8'), 'historical-user-data');
  assert.throws(() => prepareBundledRuntime({ ...options, framework: 'napcat' }), /仅支持 SnowCat/);
  assert.equal(snowcat.childEnv.QQ_FRAMEWORK, 'snowcat');
  assert.equal(snowcat.env.QQ_FRAMEWORK, 'snowcat');
  assert.match(snowcat.childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY, /^[a-f0-9]{64}$/);
  assert.notEqual(snowcat.childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY, snowcat.env.NAPCAT_WEBUI_TOKEN);
  assert.equal(prepareBundledRuntime({ ...options, framework: 'snowcat' }).childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY, snowcat.childEnv.NAPCAT_WEBUI_JWT_SECRET_KEY);
  assert.equal(prepareBundledRuntime(options).env.NAPCAT_WEBUI_TOKEN, original.env.NAPCAT_WEBUI_TOKEN);
});
