import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { startNapcatMock } from '../napcat-mock.fixture.js';
import { bindLogPanel } from '../public/napcat-ui.js';
import { oneBotCall } from '../qq-bridge.js';

async function start(t, seed) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmz-logs-'));
  if (seed) {
    const db = new DatabaseSync(path.join(dataDir, 'ownman.db'));
    db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,time TEXT NOT NULL,level TEXT NOT NULL,area TEXT NOT NULL,message TEXT NOT NULL)');
    seed(db); db.close();
  }
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) }, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function request(endpoint, method = 'GET', payload, token) {
    const res = await fetch(base + '/api' + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-Webhook-Token': token } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, ...await res.json() };
  }
  for (let i = 0; i < 100; i++) {
    try { await request('/bootstrap'); return { request, dataDir }; }
    catch { await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  assert.fail('log test server did not start');
}
const setup = request => request('/setup', 'POST', { username: 'admin', password: 'local-log-test-password' });

test('old English logs migrate, translate and filter personal QQ before applying the limit', async t => {
  const { request, dataDir } = await start(t, db => {
    const insert = db.prepare('INSERT INTO logs(time,level,area,message) VALUES(?,?,?,?)');
    insert.run('2026-11-01T00:00:00Z', 'info', 'qq', 'private message 123 from 456');
    insert.run('2026-11-01T00:00:00Z', 'info', 'napcat', 'NapCat management configuration saved');
    insert.run('2026-11-01T00:00:00Z', 'error', 'plugin', 'Unknown historical source');
    for (let i = 0; i < 120; i++) insert.run('2026-11-01T00:00:00Z', 'error', 'qqbot', 'QQ Bot WebSocket connection failed');
    insert.run('2026-11-01T00:00:00Z', 'info', 'rebate', 'jd automatic conversion');
  });
  assert.equal((await request('/logs?source=qq')).status, 401);
  await setup(request);
  const personal = (await request('/logs?source=qq')).logs;
  assert.equal(personal.length, 2, 'QQ records older than the global latest 100 are still returned');
  assert.equal(personal[1].message, '收到私聊消息；会话：456；消息编号：123');
  assert.equal(personal[1].areaLabel, '个人 QQ'); assert.equal(personal[1].levelLabel, '信息');
  assert.match(personal[0].message, /连接配置已保存/);
  assert.equal((await request('/logs?source=qq&level=error')).logs.length, 0);
  assert.equal((await request('/logs?source=qq&area=qq')).logs.length, 1);
  const bots = (await request('/logs?area=qqbot&level=error')).logs;
  assert.equal(bots.length, 100); assert.match(bots[0].message, /长连接失败/); assert.equal(bots[0].levelLabel, '错误');
  assert.equal((await request('/logs?area=rebate')).logs[0].message, '京东自动转链成功');
  assert.equal((await request('/overview')).recentLogs[0].message, '管理员账号已创建');
  const db = new DatabaseSync(path.join(dataDir, 'ownman.db'));
  assert.ok(db.prepare('PRAGMA table_info(logs)').all().some(column => column.name === 'source'));
  db.close();
});

test('personal QQ logs include its plugin errors and send results, exclude other sources, and hide credentials', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  const { request, dataDir } = await start(t);
  await setup(request);
  const { webhookToken } = await request('/settings');
  await request('/qq', 'PUT', { enabled: true, endpoint: mock.base, accessToken: 'qq-log-private-secret' });
  const plugin = await request('/plugins', 'POST', { name: '日志测试', source: 'function handle(event, api) { if (event.text === "error") throw new Error("upstream E_TEST_42"); api.reply("pong"); }' });
  await request(`/plugins/${plugin.id}/toggle`, 'POST', {});
  const callback = (id, text) => request('/qq/events', 'POST', { post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: id, raw_message: text }, webhookToken);
  assert.equal((await callback(1, 'ok')).status, 200);
  assert.equal((await callback(2, 'error')).status, 502);
  await request('/events', 'POST', { channel: 'qqbot', chatId: 'other', text: 'error' }, webhookToken);
  const db = new DatabaseSync(path.join(dataDir, 'ownman.db'));
  db.prepare('INSERT INTO logs(time,level,area,message,source) VALUES(?,?,?,?,?)').run(new Date().toISOString(), 'error', 'ai', `QQ qq-log-private-secret ${webhookToken} https://example.com?token=hidden-secret Bearer hidden-bearer`, 'qq');
  const all = (await request('/logs?source=qq')).logs;
  assert.ok(all.some(item => item.message.includes('处理完成：成功发送 1 条')));
  assert.ok(all.some(item => item.message.includes('回复成功；目标：个人 QQ 私聊 123')));
  assert.ok(all.some(item => item.area === 'plugin' && item.source === 'qq' && item.message.includes('E_TEST_42')));
  assert.ok(all.some(item => item.message.includes('自动重试 1/3')));
  assert.ok(!all.some(item => item.source === 'qqbot' || item.area === 'qqbot'));
  const serialized = JSON.stringify(all);
  for (const secret of ['qq-log-private-secret', webhookToken, 'hidden-secret', 'hidden-bearer']) assert.ok(!serialized.includes(secret));
  const stored = db.prepare("SELECT message FROM logs WHERE area='forward' AND source='qq'").get();
  assert.match(stored.message, /回复成功/);
  db.close();
});

test('NapCat login transitions log once per change and remain isolated from global events', async t => {
  const mock = await startNapcatMock(); t.after(mock.close);
  const { request } = await start(t); await setup(request);
  await request('/napcat', 'PUT', { webuiUrl: mock.base, webuiToken: mock.state.token, onebotUrl: mock.base, callbackBaseUrl: 'http://xiaomizhou:8090' });
  await request('/napcat/status'); await request('/napcat/status');
  mock.state.loggedIn = true;
  await request('/napcat/status'); await request('/napcat/status');
  mock.state.loggedIn = false; mock.state.offline = true;
  await request('/napcat/status'); await request('/napcat/status');
  const logs = (await request('/logs?source=qq&area=napcat')).logs;
  for (const text of ['等待手机 QQ 扫码', 'QQ 登录成功', 'QQ 已掉线']) assert.equal(logs.filter(item => item.message.includes(text)).length, 1);
  assert.ok(logs.every(item => !item.message.includes(mock.state.token)));
});

test('log refresh discards stale responses, recovers from errors and stops when the page is disposed', async t => {
  const nodes = Object.fromEntries(['level', 'area', 'auto', 'refresh', 'status', 'rows'].map(key => [`[data-log-${key}]`, { value: '', checked: true, innerHTML: '', textContent: '' }]));
  const panel = { isConnected: true, querySelector: selector => nodes[selector] };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => panel };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const dispose = bindLogPanel({ id: 'test', personal: true, api: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })), escapeHtml: value => String(value).replaceAll('<', '&lt;'), date: String, active: () => true });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  nodes['[data-log-level]'].value = 'error';
  const newer = nodes['[data-log-level]'].onchange();
  assert.equal(requests[1].url, '/logs?source=qq&level=error');
  requests[1].resolve({ logs: [{ level: 'error', levelLabel: '错误', areaLabel: '个人 QQ', message: '<new>', time: 'now' }] });
  await newer;
  requests[0].resolve({ logs: [{ message: 'stale' }] }); await settle();
  assert.match(nodes['[data-log-rows]'].innerHTML, /&lt;new>/);
  assert.doesNotMatch(nodes['[data-log-rows]'].innerHTML, /stale/);
  t.mock.timers.tick(5000);
  requests[2].reject(new Error('暂时不可达')); await settle();
  assert.match(nodes['[data-log-status]'].textContent, /日志刷新失败/);
  t.mock.timers.tick(5000);
  requests[3].resolve({ logs: [] }); await settle();
  assert.match(nodes['[data-log-rows]'].innerHTML, /暂无符合条件/);
  dispose(); t.mock.timers.tick(20000);
  assert.equal(requests.length, 4, 'no polling remains after navigating away');
});

test('QQ send failure keeps the upstream reason alongside the error code', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ status: 'failed', retcode: 100, wording: '目标群不存在' }) }));
  await assert.rejects(oneBotCall({ endpoint: 'http://127.0.0.1:3000' }, 'send_group_msg', {}), /retcode 100；原因：目标群不存在/);
});
