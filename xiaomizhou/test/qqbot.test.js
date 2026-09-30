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
  assert.deepEqual(qqBotDestination({ type: 'forward', channel: 'qqbot', target: 'private:other' }, event), { type: 'private', id: 'other' });
  assert.equal(qqBotDestination({ type: 'forward', channel: 'qqbot', target: 'bad' }, event), null);
});
