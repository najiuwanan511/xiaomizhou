import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createWecomBridge, wecomCallback, wecomDestination, wecomEvent, wecomSignature } from '../wecom-bridge.js';

const key = crypto.randomBytes(32);
const config = { enabled: true, corpId: 'wwtestcorp', agentId: '100001', secret: 'app-secret', token: 'callback-token', encodingAesKey: key.toString('base64').replace(/=$/, '') };

function callback(text) {
  const content = Buffer.from(text);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([crypto.randomBytes(16), length, content, Buffer.from(config.corpId)])), cipher.final()]).toString('base64');
  const query = new URLSearchParams({ timestamp: String(Math.floor(Date.now() / 1000)), nonce: '123', echostr: encrypted });
  query.set('msg_signature', wecomSignature(config.token, query.get('timestamp'), query.get('nonce'), encrypted));
  return { query, encrypted };
}

test('WeCom callback verifies and decrypts messages with stable user IDs', () => {
  const message = '<xml><ToUserName><![CDATA[wwtestcorp]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>12345678901234567890</MsgId><AgentID>100001</AgentID></xml>';
  const { query, encrypted } = callback(message);
  assert.equal(wecomCallback(null, config, query), message);
  const clear = wecomCallback(`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`, config, query);
  const event = wecomEvent(clear, config);
  assert.equal(event.chatId, 'zhangsan');
  assert.equal(event.userId, 'zhangsan');
  assert.equal(event.deliveryKey, 'wecom:zhangsan:12345678901234567890');
  assert.deepEqual(wecomDestination({ type: 'reply' }, event), { userId: 'zhangsan' });
  assert.deepEqual(wecomDestination({ type: 'forward', channel: 'wecom', target: 'user:lisi' }, event), { userId: 'lisi' });
  assert.equal(wecomDestination({ type: 'forward', channel: 'wecom', target: 'group:123' }, event), null);
  query.set('nonce', 'changed');
  assert.throws(() => wecomCallback(null, config, query), /signature/);
  assert.throws(() => wecomEvent('<!DOCTYPE foo><xml></xml>', config), /XML/);
});

test('WeCom sends app text to a member with one cached access token', async () => {
  const calls = [];
  const bridge = createWecomBridge({ getConfig: () => config, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => String(url).includes('/gettoken') ? { errcode: 0, access_token: 'test-token', expires_in: 7200 } : { errcode: 0, errmsg: 'ok' } };
  } });
  await bridge.send({ userId: 'zhangsan' }, '回复');
  await bridge.send({ userId: 'lisi' }, '转发');
  assert.equal(calls.filter(call => call.url.includes('/gettoken')).length, 1);
  assert.match(calls[1].url, /message\/send\?access_token=test-token/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { touser: 'zhangsan', msgtype: 'text', agentid: 100001, text: { content: '回复' }, safe: 0 });
  assert.equal(JSON.parse(calls[2].options.body).touser, 'lisi');
  await assert.rejects(bridge.send({ userId: 'zhangsan' }, '中'.repeat(683)), /2048 bytes/);
});
