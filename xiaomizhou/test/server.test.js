import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyRebates, formatRebate, imageUrl, productUrls, validateRebateTemplate } from '../rebate-automation.js';
import { oneBotEvent, sendQq } from '../qq-bridge.js';

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('setup, plugin lifecycle, webhook, and official rebate configuration', async () => {
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
    assert.equal((await request('/api/rebates')).status, 401);
    assert.equal((await request('/api/qqbot')).status, 401);
    assert.equal((await request('/api/updates')).status, 401);
    assert.equal((await fetch(base + '/api/backup')).status, 401);
    assert.equal((await request('/api/setup', 'POST', { username: 'admin', password: 'a-long-test-password' })).status, 200);
    assert.equal((await request('/api/bootstrap')).result.authenticated, true);
    assert.equal((await request('/api/updates')).result.managed, false);
    assert.equal((await request('/api/updates/install', 'POST', { version: '0.3.0' })).status, 409);
    assert.equal((await request('/api/ai')).result.enabled, false);
    assert.equal((await request('/api/ai', 'PUT', { enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: '', systemPrompt: '', channels: ['qq'], groupPrefix: 'AI' })).status, 400);
    assert.equal((await request('/api/ai', 'PUT', { enabled: false, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', systemPrompt: 'Test prompt', channels: ['qq'], groupPrefix: 'AI', webSearch: true, timeZone: 'Asia/Shanghai' })).status, 200);
    assert.equal((await request('/api/ai')).result.apiKey, '********');
    assert.equal((await request('/api/ai')).result.webSearch, true);
    assert.equal((await request('/api/ai', 'PUT', { enabled: false, provider: 'openai', model: 'gpt-4.1-mini', apiKey: '********', systemPrompt: 'Test prompt', channels: ['qq'], groupPrefix: 'AI', webSearch: false, timeZone: 'UTC' })).status, 200);
    assert.equal((await request('/api/ai')).result.timeZone, 'UTC');
    assert.equal((await request('/api/ai/test', 'POST', { text: '' })).status, 400);
    assert.equal((await request('/api/ai/history', 'DELETE')).status, 200);
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
    assert.equal((await fetch(base + '/api/ai/proposals')).status, 401);
    assert.equal((await fetch(base + '/api/ai/proposals/1/approve', { method: 'POST' })).status, 401);
    assert.equal((await request('/api/ai', 'PUT', { enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: '********', systemPrompt: 'Test prompt', channels: ['qq'], groupPrefix: 'AI', webSearch: false, timeZone: 'UTC' })).status, 200);
    const configMessage = await request('/api/events', 'POST', { channel: 'qq', chatId: 'admin-chat', userId: 'requester', text: '开启联网搜索' }, { 'X-Webhook-Token': token });
    assert.match(configMessage.result.actions[0].text, /管理员.*确认/);
    const proposal = (await request('/api/ai/proposals')).result.proposals[0];
    assert.equal(proposal.key, 'webSearch');
    assert.equal((await request('/api/ai')).result.webSearch, false);
    assert.equal((await request(`/api/ai/proposals/${proposal.id}/approve`, 'POST')).status, 200);
    assert.equal((await request('/api/ai')).result.webSearch, true);
    assert.equal((await request(`/api/ai/proposals/${proposal.id}/approve`, 'POST')).status, 404);
    assert.equal((await request('/api/ai', 'PUT', { enabled: false, provider: 'openai', model: 'gpt-4.1-mini', apiKey: '********', systemPrompt: 'Test prompt', channels: ['qq'], groupPrefix: 'AI', webSearch: false, timeZone: 'UTC' })).status, 200);
    const wake = await request('/api/events', 'POST', { channel: 'qq', chatId: 'admin-chat', userId: 'requester', text: '开启AI回复' }, { 'X-Webhook-Token': token });
    assert.match(wake.result.actions[0].text, /已提交/);
    const wakeProposal = (await request('/api/ai/proposals')).result.proposals[0];
    assert.equal((await request(`/api/ai/proposals/${wakeProposal.id}/reject`, 'POST')).status, 200);
    assert.equal((await request('/api/ai')).result.enabled, false);
    assert.equal((await request('/api/qqbot', 'PUT', { enabled: true, appId: 'bad', appSecret: 'secret' })).status, 400);
    assert.equal((await request('/api/qqbot', 'PUT', { enabled: false, appId: '123', appSecret: 'secret' })).status, 200);
    assert.equal((await request('/api/qqbot')).result.appSecret, 'secret');
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
    assert.equal(rebate.status, 400);
    assert.match(rebate.result.error, /official affiliate connector/);
    assert.equal((await request('/api/rebates', 'PUT', { platform: 'jd', mode: 'test', appKey: 'app-key', appSecret: 'secret' })).status, 400);
    assert.equal((await request('/api/rebates', 'PUT', { platform: 'jd', provider: 'custom', endpoint: 'https://example.com' })).status, 400);
    assert.equal((await request('/api/rebates', 'PUT', { platform: 'jd', appKey: 'app-key', appSecret: 'secret', siteId: '1234' })).status, 200);
    const savedJd = (await request('/api/rebates')).result.providers.jd;
    assert.equal(savedJd.appSecret, 'secret');
    assert.equal(savedJd.appKey, 'app-key');
    assert.equal(savedJd.configured, true);
    assert.equal((await request('/api/rebates', 'PUT', { platform: 'jd', appKey: 'app-key', appSecret: '********', siteId: '1234' })).status, 200);
    assert.equal((await request('/api/rebates')).result.providers.jd.appSecret, 'secret');
    assert.equal((await request('/api/rebates', 'PUT', { platform: 'taobao', appKey: 'app-key', appSecret: 'secret', adzoneId: 'bad' })).status, 400);
    assert.equal((await request('/api/rebates', 'PUT', { platform: 'pdd', clientId: 'client-id', clientSecret: 'client-secret' })).status, 400);
    assert.equal((await request('/api/rebates', 'PUT', { platform: 'pdd', clientId: 'client-id', clientSecret: 'client-secret', pid: '123_456' })).status, 200);
    assert.equal((await request('/api/rebates')).result.providers.pdd.clientSecret, 'client-secret');
    assert.equal((await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true })).result.enabled, true);
    assert.equal((await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true, template: '商品：{{name}}' })).status, 400);
    assert.equal((await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true, template: '{{url}} {{unknown}}' })).status, 400);
    assert.equal((await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true, template: '链接：{{url}}' })).result.template, '链接：{{url}}');
    assert.equal((await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true, image: true })).result.image, true);
    assert.equal((await request('/api/rebates/automation')).result.image, true);
    assert.equal((await request('/api/rebates/automation', 'PUT', { enabled: false, reply: true })).result.enabled, false);
    const automatic = await request('/api/events', 'POST', { channel: 'qq', chatId: '123', text: '看看 https://item.jd.com/123.html。' }, { 'X-Webhook-Token': token });
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
  assert.equal(success.actions[0].text, '商品 返利链接：https://promo.example/abc');
  assert.equal(success.actions[1].type, 'reply');
  assert.equal(success.actions[1].text, '返利链接：https://promo.example/abc');
  const withPicture = await applyRebates(event, { actions: actions(), errors: [] }, { enabled: true, reply: true, image: true }, async () => ({ platform: 'jd', mode: 'live', resultUrl: 'https://promo.example/abc', imageUrl: 'https://cdn.example.com/product.jpg' }), platformFor, () => {});
  assert.deepEqual(withPicture.actions[0].images, [{ url: 'https://cdn.example.com/product.jpg' }]);
  assert.deepEqual(withPicture.actions[1].images, withPicture.actions[0].images);
  const withoutPicture = await applyRebates(event, { actions: actions(), errors: [] }, { enabled: true, reply: true, image: false }, async () => ({ platform: 'jd', mode: 'live', resultUrl: 'https://promo.example/abc', imageUrl: 'https://cdn.example.com/product.jpg' }), platformFor, () => {});
  assert.equal(withoutPicture.actions[0].images, undefined);
  assert.equal(imageUrl('http://cdn.example.com/a.jpg'), null);
  assert.equal(imageUrl('https://localhost/a.jpg'), null);
  const detailed = await applyRebates(event, { actions: actions(), errors: [] }, { enabled: true, reply: true, template: '商品：{{name}}\n链接：{{url}}\n口令：{{code}}\n预计返利：{{estimate}}' }, async () => ({ platform: 'jd', mode: 'live', resultUrl: 'https://promo.example/abc', name: '测试商品', code: '￥abc￥', estimate: '2.30 元' }), platformFor, () => {});
  assert.equal(detailed.actions[1].text, '商品：测试商品\n链接：https://promo.example/abc\n口令：￥abc￥\n预计返利：2.30 元');
  assert.equal(detailed.actions[0].text, `商品 ${detailed.actions[1].text}`);
  const failure = await applyRebates(event, { actions: actions(), errors: [] }, { enabled: true, reply: true }, async () => { throw new Error('API unavailable'); }, platformFor, (...args) => logs.push(args));
  assert.equal(failure.actions[0].type, 'blocked');
  assert.match(failure.errors[0].message, /API unavailable/);
  assert.equal(failure.actions.some(action => action.type === 'reply'), false);
});

test('rebate template omits missing fields and keeps one link per product', () => {
  const template = validateRebateTemplate('商品：{{name}}\n链接：{{url}}\n口令：{{code}}\n预计返利：{{estimate}}');
  assert.equal(formatRebate({ mode: 'live', resultUrl: 'https://promo.example/a', name: 'A\nB', estimate: 2.3 }, template), '商品：A B\n链接：https://promo.example/a\n预计返利：2.30 元');
  assert.equal(formatRebate({ mode: 'live', resultUrl: 'https://promo.example/a' }, '{{name}} {{url}}'), '返利链接：https://promo.example/a');
  assert.equal(formatRebate({ mode: 'test', resultUrl: null }, template), '');
});

test('OneBot accepts image-only messages and sends text with product pictures', async () => {
  const event = oneBotEvent({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 7, message: [{ type: 'image', data: { url: 'https://cdn.example.com/a.jpg' } }] });
  assert.deepEqual(event.images, [{ url: 'https://cdn.example.com/a.jpg', mimeType: 'image/jpeg' }]);
  const port = await freePort();
  let body;
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }));
  });
  await new Promise(resolve => mock.listen(port, '127.0.0.1', resolve));
  try {
    await sendQq({ endpoint: `http://127.0.0.1:${port}` }, { type: 'private', id: '123' }, '推广链接', event.images);
    assert.deepEqual(body.message, [{ type: 'text', data: { text: '推广链接' } }, { type: 'image', data: { file: 'https://cdn.example.com/a.jpg' } }]);
  } finally { await new Promise(resolve => mock.close(resolve)); }
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

test('QQ messages use AI memory and plugin replies take precedence', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xiaomizhou-ai-test-'));
  const port = await freePort();
  const apiPort = await freePort();
  const sent = [];
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    sent.push(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }));
  });
  await new Promise(resolve => mock.listen(apiPort, '127.0.0.1', resolve));
  const child = spawn(globalThis.process.execPath, ['--import', './ai-fetch-mock.fixture.js', 'server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...globalThis.process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function request(endpoint, method = 'GET', payload, token) {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-Webhook-Token': token } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, result: await response.json() };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/bootstrap'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.ok(ready);
    assert.equal((await request('/api/setup', 'POST', { username: 'admin', password: 'a-long-test-password' })).status, 200);
    const token = (await request('/api/settings')).result.webhookToken;
    await request('/api/qq', 'PUT', { enabled: true, endpoint: `http://127.0.0.1:${apiPort}`, accessToken: '' });
    await request('/api/ai', 'PUT', { enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', systemPrompt: 'Test', channels: ['qq'], groupPrefix: 'AI' });
    const event = id => ({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: id, raw_message: `message-${id}` });
    assert.equal((await request('/api/qq/events', 'POST', event(1), token)).result.delivered, 1);
    assert.equal(sent.at(-1).message, 'AI-1');
    assert.equal((await request('/api/qq/events', 'POST', event(2), token)).result.delivered, 1);
    assert.equal(sent.at(-1).message, 'AI-3');
    assert.equal((await request('/api/qq/events', 'POST', event(2), token)).result.delivered, 0);
    assert.equal(sent.length, 2);
    assert.equal((await request('/api/ai')).result.historyCount, 2);
    const plugin = await request('/api/plugins', 'POST', { name: 'Override', source: 'function handle(event, api) { if (event.text === "plugin") api.reply("Plugin"); }' });
    await request(`/api/plugins/${plugin.result.id}/toggle`, 'POST', {});
    const third = { ...event(3), raw_message: 'plugin' };
    const outcome = await request('/api/qq/events', 'POST', third, token);
    assert.equal(outcome.result.actions.length, 1);
    assert.equal(sent.at(-1).message, 'Plugin');
    assert.equal((await request('/api/ai')).result.historyCount, 2);
    assert.equal((await request('/api/ai/history', 'DELETE')).status, 200);
    assert.equal((await request('/api/ai')).result.historyCount, 0);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    await new Promise(resolve => mock.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
