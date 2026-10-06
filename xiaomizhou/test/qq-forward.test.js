import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { oneBotEvent, qqMessageContent, expandQqForward, qqForwardActions, createQqBatchQueue } from '../qq-bridge.js';
import { applyRebates } from '../rebate-automation.js';

const text = value => ({ type: 'text', data: { text: value } });
const image = { type: 'image', data: { url: 'http://gchat.qpic.cn/example.jpg' } };
const forward = id => ({ type: 'forward', data: { id } });
const incoming = (id, message, group = 321) => ({ post_type: 'message', message_type: 'group', user_id: 123, self_id: 999, group_id: group, message_id: id, message });
const rule = { id: 1, source_channel: 'qq', source_chat_id: '321', target_channel: 'qq', target: 'group:456', mode: 'all', include_images: 1, split_forward: 1, send_interval: 500 };

test('QQ CQ and array messages retain HTTP images and text order without forwarding local files or CQ commands', () => {
  const event = oneBotEvent(incoming(1, '[CQ:image,url=http://gchat.qpic.cn/a.jpg?a=1&amp;b=2]前&#91;文&#93;[CQ:at,qq=all]https://example.com'));
  assert.equal(event.text, '前[文]https://example.com');
  assert.equal(event.images[0].url, 'http://gchat.qpic.cn/a.jpg?a=1&b=2');
  assert.deepEqual(event.segments.map(p => p.type), ['image', 'text', 'text']);
  assert.equal(oneBotEvent(incoming(1, [forward('record')])).hasForward, true);
  assert.equal(oneBotEvent({ ...incoming(1, [text('self')]), user_id: 999 }), null);
  assert.deepEqual(qqMessageContent([{ type: 'image', data: { file: 'file:///etc/passwd' } }, { type: 'image', data: { url: 'http://127.0.0.1/a' } }]).images, []);
  assert.throws(() => qqMessageContent([text('x'.repeat(4001))]), /4000/);
  assert.throws(() => qqMessageContent(Array(11).fill(image)), /10/);
});

test('NapCat and standard OneBot merged records flatten in order, with switches and bounded recursion', async () => {
  const event = oneBotEvent(incoming(2, [text('前言'), forward('a'), text('结尾')]));
  let calls = 0;
  event.forwardMessages = await expandQqForward(event, {}, async (_config, action, params) => {
    calls++;
    assert.equal(action, 'get_forward_msg');
    assert.equal(params.id, params.message_id);
    if (params.id === 'a') return { messages: [{ type: 'node', data: { content: [], message: [image, text('图后文字')] } }, { message: [text('https://example.com'), forward('b')] }] };
    return { message: [{ type: 'node', data: { content: [text('内层')] } }] };
  });
  assert.equal(calls, 2);
  assert.deepEqual(event.forwardMessages.map(m => m.text), ['前言', '图后文字', 'https://example.com', '内层', '结尾']);
  const actions = qqForwardActions(event, rule);
  assert.equal(actions.length, 5);
  assert.deepEqual(actions[1].segments.map(p => p.type), ['image', 'text']);
  assert.equal(qqForwardActions(event, { ...rule, mode: 'links' }).length, 1);
  assert.equal(qqForwardActions(event, { ...rule, split_forward: 0 }).length, 1);
  assert.ok(qqForwardActions(event, { ...rule, include_images: 0 }).every(a => !a.images.length && a.segments.every(p => p.type === 'text')));
  assert.deepEqual(qqForwardActions(event, { ...rule, target: 'group:321' }), []);
  const only = oneBotEvent(incoming(3, [image]));
  assert.equal(qqForwardActions(only, rule).length, 1);
  assert.equal(qqForwardActions(only, { ...rule, include_images: 0 }).length, 0);
  await assert.rejects(expandQqForward(event, {}, async () => ({ messages: [] })), /未返回/);
  await assert.rejects(expandQqForward(event, {}, async () => ({ messages: [{ message: [forward('a')] }] })), /循环/);
  await assert.rejects(expandQqForward(event, {}, async () => ({ messages: Array.from({ length: 51 }, () => ({ message: [text('node')] })) })), /50/);
  let index = 0;
  await assert.rejects(expandQqForward(event, {}, async () => ({ messages: [{ message: [forward(String(++index))] }] })), /3 层/);
});

test('merged Taobao nodes pass complete share text to conversion and discard original URL segments', async () => {
  const share = '【淘宝】https://m.tb.cn/h.example「商品」 ￥Abc123xyZ89￥';
  const event = { text: '', hasForward: true, forwardMessages: [{ text: share }] };
  const action = { type: 'forward', text: share, segments: [text(share)], images: [{ url: image.data.url }] };
  const result = await applyRebates(event, { actions: [action], errors: [] }, { enabled: true, reply: false, image: true }, async ({ url }) => {
    assert.equal(url, share);
    return { mode: 'live', platform: 'taobao', resultUrl: 'https://s.click.taobao.com/promo', imageUrl: 'https://img.alicdn.com/goods.jpg' };
  }, url => url.includes('tb.cn') ? 'taobao' : null, () => {});
  assert.equal(result.actions.length, 1);
  assert.ok(!action.text.includes('m.tb.cn'));
  assert.equal(action.segments, undefined);
  assert.equal(action.images.length, 2);
});

test('QQ batch queue preserves batch order and recovers after a failed batch', async () => {
  const queue = createQqBatchQueue();
  const order = [];
  const first = queue(async () => { order.push('a1'); await new Promise(resolve => setTimeout(resolve, 10)); order.push('a2'); throw Error('fail'); });
  const second = queue(async () => { order.push('b1'); order.push('b2'); });
  const result = await Promise.allSettled([first, second]);
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[1].status, 'fulfilled');
  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
});

test('server migrates old rules, sends ordered graph messages, caches split records and resumes after failure', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xiaomizhou-forward-'));
  const oldDb = new DatabaseSync(path.join(dataDir, 'ownman.db'));
  oldDb.exec("CREATE TABLE forward_rules (id INTEGER PRIMARY KEY, source_channel TEXT NOT NULL, source_chat_id TEXT NOT NULL, target_channel TEXT NOT NULL, target TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'all', enabled INTEGER NOT NULL DEFAULT 1); INSERT INTO forward_rules(source_channel,source_chat_id,target_channel,target) VALUES('qq','321','qq','group:456')");
  oldDb.close();
  const sent = [];
  let lookups = 0;
  let fail = true;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let data = {};
    let status = 'ok', retcode = 0;
    if (req.url === '/get_forward_msg') {
      lookups++;
      if (body.message_id === 'empty') data = { messages: [] };
      else data = { messages: [{ message: [text('第一条'), image, text('链接 https://example.com')] }, { type: 'node', data: { content: [image] } }, { message: [text('第三条')] }] };
    } else if (req.url === '/send_group_msg') {
      sent.push(body);
      if (fail && body.message?.[0]?.type === 'image') { fail = false; status = 'failed'; retcode = 100; }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status, retcode, data }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  // Get an unused port for the child server.
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/api/bootstrap`); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); } }
    assert.ok(ready);
  }
  async function stop() { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
  let cookie = '';
  let token = '';
  async function request(endpoint, method = 'GET', payload, callback = false) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(callback ? { 'X-Webhook-Token': token } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, result: await response.json() };
  }
  try {
    await start();
    await request('/api/setup', 'POST', { username: 'admin', password: 'long-test-password' });
    token = (await request('/api/settings')).result.webhookToken;
    const migrated = (await request('/api/forwards')).result.rules[0];
    assert.equal(migrated.includeImages, true); assert.equal(migrated.splitForward, true); assert.equal(migrated.sendInterval, 1000);
    assert.equal((await request('/api/forwards/1', 'PUT', { ...migrated, sendInterval: 1 })).status, 400);
    assert.equal((await request('/api/forwards/1', 'PUT', { ...migrated, target: 'group:321' })).status, 400);
    await request('/api/forwards/1', 'PUT', { ...migrated, sendInterval: 500 });
    await request('/api/qq', 'PUT', { enabled: true, endpoint: `http://127.0.0.1:${mock.address().port}`, accessToken: 'test-token' });
    const post = event => request('/api/qq/events', 'POST', event, true);
    const event = incoming(10, [forward('record')]);
    const failed = await post(event);
    assert.equal(failed.status, 502); assert.equal(failed.result.delivered, 1);
    assert.equal(sent.length, 2); // Third node was not sent ahead of the failed image.
    assert.deepEqual(sent[0].message.map(p => p.type), ['text', 'image', 'text']);
    assert.ok(!sent.some(body => body.message.some(p => ['node', 'forward'].includes(p.type))));
    await stop();
    const retryDb = new DatabaseSync(path.join(dataDir, 'ownman.db'));
    retryDb.prepare('UPDATE qq_pending_events SET next_retry_at=0 WHERE message_id=?').run('999:group:321:10');
    retryDb.close();
    await start(); // Durable retry resumes automatically after restart.
    for (let i = 0; i < 200 && sent.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(sent.length, 4, 'automatic retry did not resume pending nodes');
    const retried = await post(event);
    assert.equal(retried.status, 200); assert.equal(retried.result.delivered, 0);
    assert.equal(lookups, 1); assert.equal(sent.length, 4);
    assert.deepEqual(sent[2].message, [{ type: 'image', data: { file: image.data.url } }]);
    assert.equal(sent[3].message[0].data.text, '第三条');
    assert.equal((await post(event)).result.delivered, 0); assert.equal(sent.length, 4);
    assert.equal((await post(incoming(11, [forward('empty')]))).status, 502); assert.equal(sent.length, 4);
    await request('/api/forwards/1', 'PUT', { ...migrated, includeImages: false, sendInterval: 500 });
    const without = await post(incoming(12, [forward('record')]));
    assert.equal(without.result.delivered, 2);
    assert.ok(sent.slice(4).every(body => body.message.every(p => p.type === 'text')));
    await request('/api/forwards/1', 'PUT', { ...migrated, splitForward: false, sendInterval: 500 });
    const count = lookups;
    assert.equal((await post(incoming(13, [forward('record')]))).result.delivered, 0); assert.equal(lookups, count);
    await request('/api/forwards/1', 'PUT', { ...migrated, sendInterval: 500 });
    const before = sent.length;
    const concurrent = await Promise.all([post(incoming(14, [forward('record')])), post(incoming(15, [forward('record')]))]);
    assert.ok(concurrent.every(r => r.result.delivered === 3));
    assert.deepEqual(sent.slice(before).map(body => body.message[0].data.text || '图片'), ['第一条', '图片', '第三条', '第一条', '图片', '第三条']);
    fail = true;
    const changedAt = sent.length;
    assert.equal((await post(incoming(16, [forward('record')]))).status, 502);
    await request('/api/forwards/1', 'PUT', { ...migrated, includeImages: false, sendInterval: 500 });
    assert.equal((await post(incoming(16, [forward('record')]))).result.delivered, 1);
    assert.equal(sent.length, changedAt + 3);
    assert.equal(sent.at(-1).message[0].data.text, '第三条');
  } finally {
    if (child?.exitCode === null) await stop();
    await new Promise(resolve => mock.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
