import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyRebates, productUrls } from '../rebate-automation.js';

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('setup, plugin lifecycle, webhook, and rebate test mode', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ownman-test-'));
  const port = await freePort();
  const process = spawn(globalThis.process.execPath, ['server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...globalThis.process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function request(endpoint, method = 'GET', payload, headers = {}) {
    const response = await fetch(base + endpoint, {
      method,
      headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: payload ? JSON.stringify(payload) : undefined
    });
    const result = await response.json();
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, result };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/bootstrap'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.ok(ready, 'server did not start');
    assert.equal((await request('/api/bootstrap')).result.setup, true);
    assert.equal((await request('/api/plugins')).status, 401);
    assert.equal((await fetch(base + '/api/backup')).status, 401);
    assert.equal((await request('/api/setup', 'POST', { username: 'admin', password: 'a-long-test-password' })).status, 200);
    assert.equal((await request('/api/bootstrap')).result.authenticated, true);
    assert.equal((await request('/api/missing')).status, 404);
    assert.equal((await fetch(base + '/missing-file.js')).status, 404);
    const source = 'function handle(event, api) { if (event.text === "ping") api.reply("pong"); }';
    const created = await request('/api/plugins', 'POST', { name: 'Ping', description: 'test', source });
    assert.equal(created.status, 201);
    const id = created.result.id;
    const snapshot = await fetch(base + '/api/backup', { headers: { Cookie: cookie } });
    assert.equal(snapshot.status, 200);
    assert.match(snapshot.headers.get('content-disposition'), /attachment; filename="xiaomizhou-.*\.db"/);
    const snapshotPath = path.join(dataDir, 'snapshot.db');
    writeFileSync(snapshotPath, Buffer.from(await snapshot.arrayBuffer()));
    const snapshotDb = new DatabaseSync(snapshotPath);
    try { assert.equal(snapshotDb.prepare('SELECT name FROM plugins WHERE id=?').get(id).name, 'Ping'); }
    finally { snapshotDb.close(); }
    assert.equal((await request(`/api/plugins/${id}/test`, 'POST', { text: 'ping' })).result.actions[0].text, 'pong');
    assert.equal((await request(`/api/plugins/${id}`, 'PUT', { name: 'Ping', source: 'function handle() { throw new Error("broken"); }' })).status, 200);
    assert.match((await request(`/api/plugins/${id}/test`, 'POST', { text: 'ping' })).result.errors[0].message, /broken/);
    assert.equal((await request(`/api/plugins/${id}`, 'PUT', { name: 'Ping', source })).status, 200);
    assert.equal((await request(`/api/plugins/${id}/toggle`, 'POST')).result.enabled, true);
    const token = (await request('/api/settings')).result.webhookToken;
    assert.equal((await request('/api/qqbot', 'PUT', { enabled: true, appId: 'bad', appSecret: 'secret' })).status, 400);
    assert.equal((await request('/api/qqbot', 'PUT', { enabled: false, appId: '123', appSecret: 'secret' })).status, 200);
    assert.equal((await request('/api/qqbot')).result.appSecret, '********');
    assert.equal((await request('/api/wecom', 'PUT', { enabled: true, corpId: 'bad', agentId: '1' })).status, 400);
    const wecomConfig = { enabled: false, corpId: 'wwtestcorp', agentId: '100001', secret: 'app-secret', token: 'callback-token', encodingAesKey: 'A'.repeat(43) };
    assert.equal((await request('/api/wecom', 'PUT', wecomConfig)).status, 200);
    assert.equal((await request('/api/wecom')).result.secret, '********');
    assert.equal((await request('/api/wecom', 'PUT', { ...wecomConfig, secret: '********', token: '********', encodingAesKey: '********', enabled: true })).status, 200);
    assert.equal((await request('/api/forwards', 'POST', { sourceChannel: 'qq', sourceChatId: '123', targetChannel: 'wecom', target: 'group:789' })).status, 400);
    assert.equal((await request('/api/events', 'POST', { channel: 'qq', chatId: '123', text: 'ping' }, { 'X-Webhook-Token': token })).result.actions[0].text, 'pong');
    assert.equal((await request('/api/forwards', 'POST', { sourceChannel: 'qq', sourceChatId: '123', targetChannel: 'qq', target: 'bad', mode: 'links' })).status, 400);
    const rule = await request('/api/forwards', 'POST', { sourceChannel: 'qq', sourceChatId: '123', targetChannel: 'qq', target: 'group:789', mode: 'links' });
    assert.equal(rule.status, 201);
    assert.equal((await request('/api/events', 'POST', { channel: 'qq', chatId: '123', text: 'plain text' }, { 'X-Webhook-Token': token })).result.actions.length, 0);
    assert.equal((await request('/api/events', 'POST', { channel: 'qq', chatId: '123', text: 'https://item.jd.com/1.html' }, { 'X-Webhook-Token': token })).result.actions[0].target, 'group:789');
    assert.equal((await request(`/api/forwards/${rule.result.id}`, 'PUT', { sourceChannel: 'qq', sourceChatId: '123', targetChannel: 'qq', target: 'group:789', mode: 'all', enabled: false })).status, 200);
    assert.equal((await request('/api/events', 'POST', { channel: 'qq', chatId: '123', text: 'https://item.jd.com/1.html' }, { 'X-Webhook-Token': token })).result.actions.length, 0);
    assert.equal((await request(`/api/forwards/${rule.result.id}`, 'DELETE')).status, 200);
    const rebate = await request('/api/rebates/convert', 'POST', { url: 'https://item.jd.com/123.html' });
    assert.equal(rebate.result.mode, 'test');
    assert.equal(rebate.result.resultUrl, null);
    assert.equal((await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true })).result.enabled, true);
    const automatic = await request('/api/events', 'POST', { channel: 'qq', chatId: '123', text: '看看 https://item.jd.com/123.html。' }, { 'X-Webhook-Token': token });
    assert.equal(automatic.result.conversions[0].mode, 'test');
    assert.equal(automatic.result.actions.length, 0);
    assert.equal((await request('/api/rebates/convert', 'POST', { url: 'https://example.com' })).status, 400);
    assert.equal((await request(`/api/plugins/${id}`, 'DELETE')).status, 200);
    assert.equal((await request('/api/plugins')).result.plugins.length, 0);
  } finally {
    const exited = new Promise(resolve => process.once('exit', resolve));
    process.kill();
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('affiliate automation replaces forward links and blocks forwarding on failure', async () => {
  const source = 'https://item.jd.com/123.html';
  const platformFor = url => url.startsWith('https://item.jd.com/') ? 'jd' : null;
  assert.deepEqual(productUrls(`看这里 ${source}。 ${source}`, platformFor), [source]);
  const event = { text: `商品 ${source}` };
  const actions = () => [{ type: 'forward', channel: 'qq', target: 'group:123', text: event.text }];
  const logs = [];
  const success = await applyRebates(event, { actions: actions(), errors: [] }, { enabled: true, reply: true }, async () => ({ platform: 'jd', mode: 'live', resultUrl: 'https://promo.example/abc' }), platformFor, (...args) => logs.push(args));
  assert.equal(success.actions[0].text, '商品 https://promo.example/abc');
  assert.equal(success.actions[1].type, 'reply');
  assert.equal(success.actions[1].text, 'https://promo.example/abc');
  const failure = await applyRebates(event, { actions: actions(), errors: [] }, { enabled: true, reply: true }, async () => { throw new Error('API unavailable'); }, platformFor, (...args) => logs.push(args));
  assert.equal(failure.actions[0].type, 'blocked');
  assert.match(failure.errors[0].message, /API unavailable/);
  assert.equal(failure.actions.some(action => action.type === 'reply'), false);
});

test('QQ OneBot callback replies, forwards, deduplicates and retries failed sends', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ownman-qq-test-'));
  const port = await freePort();
  const apiPort = await freePort();
  const calls = [];
  let failNext = false;
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, token: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(failNext ? { status: 'failed', retcode: 100 } : { status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? { user_id: 999, nickname: 'TestBot' } : {} }));
    failNext = false;
  });
  await new Promise(resolve => mock.listen(apiPort, '127.0.0.1', resolve));
  const child = spawn(globalThis.process.execPath, ['server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...globalThis.process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function request(endpoint, payload, token) {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-Webhook-Token': token } : {}) }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, result };
  }
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/bootstrap'); break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.equal((await request('/api/setup', { username: 'admin', password: 'a-long-test-password' })).status, 200);
    const token = (await (await fetch(base + '/api/settings', { headers: { Cookie: cookie } })).json()).webhookToken;
    const plugin = await request('/api/plugins', { name: 'QQ test', source: "function handle(event, api) { api.reply('pong'); api.forward('qq', 'group:456', event.text); }" });
    await request(`/api/plugins/${plugin.result.id}/toggle`, {});
    const config = await fetch(base + '/api/qq', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, endpoint: `http://127.0.0.1:${apiPort}`, accessToken: 'napcat-secret' }) });
    assert.equal(config.status, 200);
    assert.equal((await request('/api/qq/test', {})).result.userId, '999');
    const event = { post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 1, raw_message: 'ping' };
    assert.equal((await request('/api/qq/events', event)).status, 401);
    assert.equal((await request('/api/qq/events', { ...event, self_id: 123 }, token)).result.ignored, true);
    assert.equal((await request('/api/qq/events', event, token)).result.delivered, 2);
    assert.equal(calls[1].path, '/send_private_msg');
    assert.deepEqual(calls[1].body, { message: 'pong', auto_escape: true, user_id: 123 });
    assert.equal(calls[1].token, 'Bearer napcat-secret');
    assert.equal(calls[2].path, '/send_group_msg');
    assert.equal(calls[2].body.group_id, 456);
    assert.equal((await request('/api/qq/events', event, token)).result.delivered, 0);
    assert.equal(calls.length, 3);
    failNext = true;
    const group = { ...event, message_type: 'group', group_id: 321, message_id: 2, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'image', data: { file: 'x' } }] };
    assert.equal((await request('/api/qq/events', group, token)).status, 502);
    assert.equal((await request('/api/qq/events', group, token)).result.delivered, 1);
    assert.equal(calls.filter(call => call.path === '/send_group_msg' && call.body.group_id === 321).length, 2);
    assert.equal(calls.find(call => call.path === '/send_group_msg' && call.body.group_id === 456 && call.body.message === 'hello')?.body.message, 'hello');
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    await new Promise(resolve => mock.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
