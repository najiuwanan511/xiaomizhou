import assert from 'node:assert/strict';
import test from 'node:test';
import { createQqBotBridge, qqBotDestination, qqBotEvent } from '../qqbot-bridge.js';

test('QQ Bot WebSocket receives messages and sends replies', async () => {
  const requests = [];
  const events = [];
  class FakeSocket {
    static instance;
    readyState = 1;
    sent = [];
    listeners = new Map();
    constructor(url) { this.url = url; FakeSocket.instance = this; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    send(value) { this.sent.push(JSON.parse(value)); }
    async emit(type, value) { await this.listeners.get(type)?.(type === 'message' ? { data: JSON.stringify(value) } : {}); }
    close() { this.readyState = 3; this.listeners.get('close')?.(); }
  }
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/getAppAccessToken')) return { ok: true, json: async () => ({ access_token: 'test-access', expires_in: '7200' }) };
    if (url.endsWith('/gateway')) return { ok: true, json: async () => ({ url: 'wss://api.bot.qq.com/websocket/' }) };
    return { ok: true, json: async () => ({ id: 'sent-message' }) };
  };
  const bridge = createQqBotBridge({ getConfig: () => ({ enabled: true, appId: '123', appSecret: 'secret' }), onEvent: event => events.push(event), onError: error => { throw error; }, fetchImpl, WebSocketImpl: FakeSocket });
  try {
    bridge.start();
    await new Promise(resolve => setImmediate(resolve));
    const socket = FakeSocket.instance;
    assert.equal(socket.url, 'wss://api.bot.qq.com/websocket/');
    await socket.emit('message', { op: 10, d: { heartbeat_interval: 45000 } });
    assert.equal(socket.sent[0].op, 2);
    assert.equal(socket.sent[0].d.token, 'QQBot test-access');
    assert.equal(socket.sent[0].d.intents, 1 << 25);
    await socket.emit('message', { op: 0, t: 'READY', d: {}, s: 1 });
    assert.equal(bridge.status.connected, true);
    await socket.emit('message', { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'msg-1', group_openid: 'group-openid', author: { member_openid: 'member-openid' }, content: '你好' }, s: 2 });
    assert.equal(events[0].channel, 'qqbot');
    assert.equal(events[0].chatId, 'group-openid');
    assert.equal(events[0].userId, 'member-openid');
    await bridge.send(qqBotDestination({ type: 'reply' }, events[0]), '回复', events[0].messageId);
    assert.match(requests.at(-1).url, /\/v2\/groups\/group-openid\/messages$/);
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), { content: '回复', msg_type: 0, msg_seq: 1, msg_id: 'msg-1' });
    await bridge.send({ type: 'private', id: 'another-user' }, '转发');
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), { content: '转发', msg_type: 0, msg_seq: 1 });
    assert.equal(requests.filter(item => item.url.endsWith('/getAppAccessToken')).length, 1);
  } finally { bridge.stop(); }
});

test('QQ Bot accepts only supported text events and explicit targets', () => {
  assert.equal(qqBotEvent({ op: 0, t: 'READY', d: {} }), null);
  assert.equal(qqBotEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: '1', author: { user_openid: 'user' }, content: ' ' } }), null);
  const event = qqBotEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: '1', author: { user_openid: 'user' }, content: 'ping' } });
  assert.equal(event.chatId, 'user');
  const imageEvent = qqBotEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: '2', author: { user_openid: 'user' }, attachments: [{ url: 'https://cdn.example.com/a.jpg', content_type: 'image/jpeg' }] } });
  assert.deepEqual(imageEvent.images, [{ url: 'https://cdn.example.com/a.jpg', mimeType: 'image/jpeg' }]);
  assert.deepEqual(qqBotDestination({ type: 'forward', channel: 'qqbot', target: 'private:other' }, event), { type: 'private', id: 'other' });
  assert.equal(qqBotDestination({ type: 'forward', channel: 'qqbot', target: 'bad' }, event), null);
});

function mediaBridge(fetchImpl) {
  return createQqBotBridge({ getConfig: () => ({ appId: '123', appSecret: 'secret' }), onEvent: () => {}, onError: () => {}, fetchImpl });
}

test('QQ Bot uploads group and private images then sends one reply containing text and media', async () => {
  for (const type of ['group', 'private']) {
    const calls = [];
    const bridge = mediaBridge(async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (url.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'test-access', expires_in: '7200' });
      assert.equal(options.headers.Authorization, 'QQBot test-access');
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/files')) return Response.json({ file_info: `${type}-file`, ttl: 300 });
      return Response.json({ id: 'sent-image' });
    });
    const sent = await bridge.send({ type, id: 'open/id' }, '返利链接：https://s.click.taobao.com/promo', 'source-message', 5, [{ url: 'https://img.alicdn.com/product.jpg' }]);
    const base = `https://api.sgroup.qq.com/v2/${type === 'group' ? 'groups' : 'users'}/open%2Fid`;
    assert.equal(calls[1].url, `${base}/files`);
    assert.deepEqual(calls[1].body, { file_type: 1, url: 'https://img.alicdn.com/product.jpg', srv_send_msg: false });
    assert.equal(calls[2].url, `${base}/messages`);
    assert.deepEqual(calls[2].body, { content: '返利链接：https://s.click.taobao.com/promo', msg_type: 7, media: { file_info: `${type}-file` }, msg_id: 'source-message', msg_seq: 5 });
    assert.deepEqual(sent.warnings, []);
    assert.equal(calls.length, 3);
  }
});

test('QQ Bot keeps rebate text and surfaces platform diagnostics when upload fails', async () => {
  for (const failure of [
    () => Response.json({ code: 304082, message: 'upload media info fail' }, { status: 400 }),
    () => Response.json({ code: '0' }),
    () => { throw new Error('fetch failed'); }
  ]) {
    const messages = [];
    const bridge = mediaBridge(async (url, options) => {
      if (url.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'test-access', expires_in: '7200' });
      if (url.endsWith('/files')) return failure();
      messages.push(JSON.parse(options.body));
      return Response.json({ id: 'text-sent' });
    });
    const result = await bridge.send({ type: 'group', id: 'g' }, '返利文案', 'msg-1', 1, [{ url: 'https://img.alicdn.com/product.jpg' }]);
    assert.deepEqual(messages, [{ content: '返利文案', msg_type: 0, msg_seq: 1, msg_id: 'msg-1' }]);
    assert.match(result.warnings[0], /上传失败/);
    assert.match(bridge.status.lastError, /上传失败/);
  }
});

test('QQ Bot validates image URLs, deduplicates photos and uses distinct reply sequences', async () => {
  const calls = [];
  const bridge = mediaBridge(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'test-access', expires_in: '7200' });
    if (url.endsWith('/files')) return Response.json({ file_info: body.url });
    return Response.json({ id: 'sent' });
  });
  const result = await bridge.send({ type: 'private', id: 'u' }, '', 'msg-1', 5, [
    { url: 'http://img.alicdn.com/a.jpg' }, { url: 'https://localhost/b.jpg' },
    { url: 'https://img.alicdn.com/a.jpg' }, { url: 'https://img.alicdn.com/a.jpg' },
    { url: 'https://img.alicdn.com/b.jpg' }, { url: 'https://img.alicdn.com/c.jpg' },
    { url: 'https://img.alicdn.com/d.jpg' }
  ]);
  assert.equal(calls.filter(call => call.url.endsWith('/files')).length, 3);
  const messages = calls.filter(call => call.url.endsWith('/messages')).map(call => call.body);
  assert.deepEqual(messages.map(message => message.msg_seq), [5, 6, 7]);
  assert.ok(messages.every(message => message.content === ' ' && message.msg_id === 'msg-1' && message.msg_type === 7));
  assert.equal(result.warnings.length, 2);
  const before = calls.length;
  await bridge.send({ type: 'private', id: 'u' }, '文字', 'msg-1', 9, []);
  assert.equal(calls.length - before, 1);
  assert.equal(calls.at(-1).body.msg_type, 0);
});

test('QQ Bot does not duplicate a successful first image when later images fail', async () => {
  const messages = [];
  const bridge = mediaBridge(async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'test-access', expires_in: '7200' });
    if (url.endsWith('/files')) return Response.json({ file_info: body.url });
    messages.push(body);
    if (body.msg_seq === 2) return Response.json({ code: 22009, message: 'msg limit exceed' }, { status: 429 });
    return Response.json({ id: 'first-sent' });
  });
  const result = await bridge.send({ type: 'group', id: 'g' }, '返利文案', 'msg', 1, [{ url: 'https://img.alicdn.com/a.jpg' }, { url: 'https://img.alicdn.com/b.jpg' }]);
  assert.equal(messages.length, 2);
  assert.equal(result.id, 'first-sent');
  assert.match(result.warnings[0], /22009.*首条图文已发送/);
});

test('QQ Bot failed media sends report error codes without claiming delivery or leaking credentials', async () => {
  const bridge = mediaBridge(async (url) => {
    if (url.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'test-access', expires_in: '7200' });
    if (url.endsWith('/files')) return Response.json({ file_info: 'media' });
    return Response.json({ code: '304083', message: 'convert media info fail secret test-access' }, { status: 400 });
  });
  await assert.rejects(bridge.send({ type: 'group', id: 'g' }, '文案', 'msg', 1, [{ url: 'https://img.alicdn.com/a.jpg' }]), error => {
    assert.match(error.message, /304083.*convert media info fail/);
    assert.ok(!error.message.includes('secret') && !error.message.includes('test-access'));
    return true;
  });
  assert.match(bridge.status.lastError, /304083/);
});
