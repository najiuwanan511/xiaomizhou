import assert from 'node:assert/strict';
import test from 'node:test';
import { aiConfig, conversationKey, generateAiReply, normalizeAiConfig, shouldAnswer } from '../ai-brain.js';

test('AI configuration and channel triggers avoid duplicate replies', () => {
  const config = normalizeAiConfig({ enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', systemPrompt: '简洁回答', channels: ['qq', 'qqbot'], groupPrefix: 'AI' });
  const event = { channel: 'qq', messageType: 'group', chatId: '123', userId: '456', text: 'AI 今天天气' };
  assert.equal(shouldAnswer(event, { actions: [], errors: [] }, config), '今天天气');
  assert.equal(shouldAnswer({ ...event, text: '今天天气' }, { actions: [], errors: [] }, config), null);
  assert.equal(shouldAnswer({ ...event, text: 'AIsomething' }, { actions: [], errors: [] }, config), null);
  assert.equal(shouldAnswer(event, { actions: [{ type: 'reply' }], errors: [] }, config), null);
  assert.equal(shouldAnswer(event, { actions: [], errors: [{ plugin: 'Affiliate conversion' }] }, config), null);
  assert.equal(shouldAnswer({ ...event, channel: 'qqbot' }, { actions: [], errors: [] }, config), 'AI 今天天气');
  assert.notEqual(conversationKey(event), conversationKey({ ...event, userId: 'other' }));
  assert.equal(aiConfig().enabled, false);
  assert.throws(() => normalizeAiConfig({ ...config, model: '../bad' }), /Invalid AI/);
  assert.equal(normalizeAiConfig({ ...config, apiKey: '********' }, config).apiKey, 'test-key');
  assert.throws(() => normalizeAiConfig({ ...config, provider: 'gemini', apiKey: '********' }, config), /API key/);
});

test('OpenAI Responses request uses history, server-side key and no storage', async () => {
  const config = normalizeAiConfig({ enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', systemPrompt: '简洁回答', channels: ['qq'], groupPrefix: 'AI' });
  let request;
  const answer = await generateAiReply(config, [{ user_text: '你好', assistant_text: '你好呀' }], '继续', async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '好的' }] }] }) };
  });
  assert.equal(answer, '好的');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body).input.map(item => item.role), ['user', 'assistant', 'user']);
  assert.equal(JSON.parse(request.options.body).store, false);
});

test('Gemini generateContent uses model roles and caps UTF-8 reply size', async () => {
  const config = normalizeAiConfig({ enabled: true, provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'google-key', systemPrompt: '简洁回答', channels: ['wecom'], groupPrefix: 'AI' });
  let request;
  const answer = await generateAiReply(config, [{ user_text: '你好', assistant_text: '你好呀' }], '继续', async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '中'.repeat(1000) }] } }] }) };
  });
  assert.match(request.url, /gemini-2\.5-flash:generateContent$/);
  assert.equal(request.options.headers['x-goog-api-key'], 'google-key');
  assert.deepEqual(JSON.parse(request.options.body).contents.map(item => item.role), ['user', 'model', 'user']);
  assert.ok(Buffer.byteLength(answer, 'utf8') <= 1800);
  await assert.rejects(generateAiReply(config, [], 'test', async () => ({ ok: false, status: 429 })), /HTTP 429/);
});
