import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createNapcatManager, parseNapcatConfig } from '../napcat-manager.js';
import { startNapcatMock } from '../napcat-mock.fixture.js';

test('NapCat config validates base URLs and preserves masked tokens without guessing credentials', () => {
  const config = parseNapcatConfig({ webuiUrl: 'http://napcat:6099/', onebotUrl: 'http://napcat:3000', callbackBaseUrl: 'http://xiaomizhou:8090', webuiToken: '********' }, { webuiToken: 'secret' });
  assert.equal(config.webuiUrl, 'http://napcat:6099');
  assert.equal(config.webuiToken, 'secret');
  assert.equal(parseNapcatConfig({ webuiToken: '' }, config).webuiToken, '');
  for (const url of ['file:///etc/passwd', 'http://user:secret@host', 'http://host/webui', 'http://host/?token=secret', 'http://host/#token', 'bad']) {
    for (const key of ['webuiUrl', 'onebotUrl', 'callbackBaseUrl']) assert.throws(() => parseNapcatConfig({ [key]: url }), error => error.status === 400);
  }
});

test('QR login, credential renewal, online/offline and matching message identity reflect actual responses', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  let config = { webuiUrl: mock.base, webuiToken: mock.state.token, onebotUrl: mock.base, callbackBaseUrl: 'http://xiaomizhou:8090' };
  let qq = {};
  const manager = createNapcatManager({ getConfig: () => config, getQqConfig: () => qq });
  const [first, second] = await Promise.all([manager.status(), manager.status()]);
  assert.equal(mock.state.logins, 1, 'concurrent status checks share one WebUI login');
  assert.equal(first.state, 'waiting'); assert.equal(first.reachable, true);
  assert.match(first.qrCode, /^data:image\/png;base64,iVBOR/);
  assert.equal(second.qrCode, first.qrCode);
  assert.ok(!JSON.stringify(first).includes(mock.state.token));
  assert.ok(!JSON.stringify(first).includes(mock.state.credential));
  await manager.refreshQr();
  assert.notEqual((await manager.status()).qrCode, first.qrCode);
  mock.state.rejectCredentials = 1;
  assert.equal((await manager.status()).state, 'waiting'); assert.equal(mock.state.logins, 2);
  mock.state.loggedIn = true;
  let online = await manager.status();
  assert.equal(online.state, 'online'); assert.equal(online.qrCode, null);
  assert.deepEqual(online.account, { userId: '123456789', nickname: '小米粥测试账号' });
  assert.equal(online.messageConnected, false);
  await manager.connect('callback-secret', saved => { qq = saved; });
  assert.equal((await manager.status()).messageConnected, true);
  mock.state.apiUin = 999;
  assert.equal((await manager.status()).messageConnected, false, 'a different QQ account must not count as connected');
  mock.state.loggedIn = false; mock.state.offline = true;
  assert.equal((await manager.status()).state, 'offline');
  mock.state.malformed = true;
  assert.equal((await manager.status()).state, 'unreachable');
  mock.state.malformed = false;
  config = { ...config, webuiToken: 'wrong-token' }; manager.clear();
  const rejected = await manager.status();
  assert.equal(rejected.state, 'auth-error'); assert.equal(rejected.reachable, false);
  assert.ok(!JSON.stringify(rejected).includes('wrong-token'));
  const failedLogins = mock.state.logins;
  await manager.status(); await manager.status();
  assert.equal(mock.state.logins, failedLogins, 'polling a wrong token must not exhaust the upstream login rate limit');
  config = { webuiUrl: '', webuiToken: '' };
  assert.equal((await manager.status()).state, 'unconfigured');
});

test('automatic message wiring preserves unrelated config, uses separate tokens and is idempotent', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  const config = { webuiUrl: mock.base, webuiToken: mock.state.token, onebotUrl: mock.base, callbackBaseUrl: 'http://xiaomizhou:8090' };
  let qq;
  const manager = createNapcatManager({ getConfig: () => config, getQqConfig: () => qq || {} });
  await assert.rejects(manager.connect('callback-secret', () => {}), error => error.status === 409);
  assert.equal(mock.state.writes, 0);
  mock.state.loggedIn = true;
  mock.state.config.network.httpServers.push({ name: 'other-http', port: 3001, enable: true, token: 'other-secret' });
  mock.state.config.network.httpClients.push({ name: 'other-callback', url: 'http://example.com/events', enable: true });
  const original = structuredClone(mock.state.config);
  await manager.connect('callback-secret', saved => { qq = saved; });
  const configured = mock.state.config;
  assert.equal(configured.musicSignUrl, original.musicSignUrl);
  assert.deepEqual(configured.network.websocketClients, original.network.websocketClients);
  assert.deepEqual(configured.network.httpServers[0], original.network.httpServers[0]);
  assert.deepEqual(configured.network.httpClients[0], original.network.httpClients[0]);
  const server = configured.network.httpServers.find(item => item.name === 'xiaomizhou-http');
  const client = configured.network.httpClients.find(item => item.name === 'xiaomizhou-events');
  assert.equal(server.port, Number(new URL(mock.base).port)); assert.equal(server.host, '0.0.0.0');
  assert.equal(server.messagePostFormat, 'array'); assert.equal(server.enable, true);
  assert.ok(server.token.length >= 32); assert.notEqual(server.token, mock.state.token);
  assert.notEqual(server.token, 'callback-secret'); assert.equal(qq.accessToken, server.token);
  assert.equal(qq.enabled, true); assert.equal(qq.endpoint, mock.base);
  assert.equal(client.url, 'http://xiaomizhou:8090/api/qq/events?token=callback-secret');
  assert.equal(client.reportSelfMessage, false);
  await manager.connect('changed-callback-secret', saved => { qq = saved; });
  assert.equal(mock.state.config.network.httpServers.length, 2);
  assert.equal(mock.state.config.network.httpClients.length, 2);
  assert.equal(qq.accessToken, server.token);
  assert.match(mock.state.config.network.httpClients[1].url, /changed-callback-secret$/);
  // No local change when upstream config is malformed or its port is occupied.
  const writes = mock.state.writes;
  mock.state.config.network.httpServers = [{ name: 'foreign', port: server.port, enable: true }];
  await assert.rejects(manager.connect('secret', () => assert.fail('must not save')), error => error.status === 409);
  assert.equal(mock.state.writes, writes);
  mock.state.config.network.httpServers = null;
  await assert.rejects(manager.connect('secret', () => assert.fail('must not save')), /格式不兼容/);
  assert.equal(mock.state.writes, writes);
});

test('management API requires admin login, masks secrets, saves wiring and serves UI assets', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xiaomizhou-napcat-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(import.meta.dirname, '..'), stdio: 'pipe',
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NAPCAT_WEBUI_URL: mock.base, NAPCAT_WEBUI_TOKEN: mock.state.token, NAPCAT_ONEBOT_URL: mock.base, NAPCAT_CALLBACK_BASE_URL: `http://127.0.0.1:${port}` }
  });
  const exited = once(child, 'exit');
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => { child.kill(); await exited; rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (url, method = 'GET', payload) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, result: await response.json() };
  };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(base + '/api/bootstrap'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 40)); }
  }
  assert.ok(ready, output);
  for (const [url, method] of [['/api/napcat', 'GET'], ['/api/napcat', 'PUT'], ['/api/napcat/status', 'GET'], ['/api/napcat/qrcode/refresh', 'POST'], ['/api/napcat/connect', 'POST'], ['/api/napcat/updates', 'GET'], ['/api/napcat/updates/install', 'POST'], ['/api/napcat/updates/rollback', 'POST']]) {
    assert.equal((await request(url, method)).status, 401);
  }
  await request('/api/setup', 'POST', { username: 'admin', password: 'long-test-password' });
  assert.equal((await request('/api/napcat/updates/check', 'POST')).status, 409);
  const config = (await request('/api/napcat')).result;
  assert.equal(config.webuiToken, '********'); assert.equal(config.webuiUrl, mock.base);
  assert.equal((await request('/api/napcat', 'PUT', { ...config, webuiUrl: 'file:///bad' })).status, 400);
  assert.equal((await request('/api/napcat', 'PUT', config)).status, 200);
  assert.equal((await request('/api/napcat/status')).result.state, 'waiting');
  assert.equal((await request('/api/napcat/qrcode/refresh', 'POST')).status, 200);
  assert.equal((await request('/api/napcat/connect', 'POST')).status, 409);
  mock.state.loggedIn = true;
  assert.equal((await request('/api/napcat/connect', 'POST')).status, 200);
  assert.equal((await request('/api/qq')).result.accessToken, '********');
  assert.equal((await request('/api/napcat/status')).result.messageConnected, true);
  assert.equal((await request('/api/qq/test', 'POST')).result.userId, mock.state.info.uin);
  const callback = mock.state.config.network.httpClients[0].url;
  const token = (await request('/api/settings')).result.webhookToken;
  assert.equal(new URL(callback).searchParams.get('token'), token);
  const event = await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ post_type: 'meta_event' }) });
  assert.equal(event.status, 200); assert.equal((await event.json()).ignored, true);
  assert.equal((await fetch(base + '/napcat-ui.js')).status, 200);
  const logs = JSON.stringify((await request('/api/logs')).result);
  assert.ok(!logs.includes(mock.state.token)); assert.ok(!logs.includes(mock.state.credential));
  assert.ok(!output.includes(mock.state.token));
});

test('bundled backend ignores external settings and connects the logged-in QQ without a user configuration step', async t => {
  const mock = await startNapcatMock(); t.after(mock.close); mock.state.loggedIn = true;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xiaomizhou-bundled-api-'));
  const db = new DatabaseSync(path.join(dataDir, 'ownman.db'));
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO settings VALUES(?,?)').run('napcat.config', JSON.stringify({ webuiUrl: 'http://old-external:6099', webuiToken: 'old-secret' }));
  db.close();
  const statusFile = path.join(dataDir, 'runtime.json');
  writeFileSync(statusFile, JSON.stringify({ state: 'running', pid: 123, restarts: 0, error: null, changedAt: new Date().toISOString() }));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NAPCAT_BUNDLED: '1', QQ_KERNEL_CONTROL: '1', NAPCAT_STATUS_FILE: statusFile, NAPCAT_WEBUI_URL: mock.base, NAPCAT_WEBUI_TOKEN: mock.state.token, NAPCAT_ONEBOT_URL: mock.base, NAPCAT_CALLBACK_BASE_URL: `http://127.0.0.1:${port}` }
  });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/api/bootstrap'); break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'bundled-test-password' }) });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const request = (url, method = 'GET') => fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'PUT' ? '{}' : undefined });
  const config = await (await request('/api/napcat')).json();
  assert.equal(config.bundled, true); assert.equal(config.webuiUrl, ''); assert.equal(config.webuiToken, '');
  assert.equal((await request('/api/napcat', 'PUT')).status, 409);
  assert.equal((await request('/api/qq', 'PUT')).status, 409);
  let connected = false;
  for (let i = 0; i < 80; i++) {
    const state = await (await request('/api/napcat/status')).json();
    if (state.messageConnected && mock.state.autoLoginAccount) { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(connected, 'bundled QQ must connect itself without POST /napcat/connect');
  assert.equal(mock.state.config.network.httpServers[0].host, '127.0.0.1');
  assert.equal(mock.state.autoLoginAccount, mock.state.info.uin);
  const state = await (await request('/api/napcat/status')).json();
  assert.equal(state.runtime.state, 'running'); assert.equal(state.runtime.pid, undefined);
  child.on('message', msg => {
    if (msg.type === 'qq-kernel-control') child.send({ type: 'qq-kernel-result', id: msg.id, ok: true, enabled: true });
  });
  assert.equal((await request('/api/napcat/restart', 'POST')).status, 200);
  assert.equal((await request('/api/napcat/updates/check', 'POST')).status, 409);
  assert.equal((await request('/api/napcat/updates/install', 'POST')).status, 409);
});
