import assert from 'node:assert/strict';
import test from 'node:test';
import { aiConfig, conversationKey, generateAiReply, normalizeAiConfig, parseAiConfigRequest, shouldAnswer } from '../ai-brain.js';

test('AI configuration and channel triggers avoid duplicate replies', () => {
  const config = normalizeAiConfig({ enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', systemPrompt: '简洁回答', channels: ['qq', 'qqbot'], groupPrefix: 'AI' });
  const event = { channel: 'qq', messageType: 'group', chatId: '123', userId: '456', text: 'AI 今天天气' };
  assert.equal(shouldAnswer(event, { actions: [], errors: [] }, config), '今天天气');
  assert.equal(shouldAnswer({ ...event, text: '今天天气' }, { actions: [], errors: [] }, config), null);
  assert.equal(shouldAnswer({ ...event, text: 'AIsomething' }, { actions: [], errors: [] }, config), null);
  assert.equal(shouldAnswer(event, { actions: [{ type: 'reply' }], errors: [] }, config), null);
  assert.equal(shouldAnswer(event, { actions: [], errors: [{ plugin: 'Affiliate conversion' }] }, config), null);
  assert.equal(shouldAnswer({ ...event, channel: 'qqbot' }, { actions: [], errors: [] }, config), 'AI 今天天气');
  assert.equal(shouldAnswer({ ...event, messageType: 'private', text: '开启AI回复' }, { actions: [], errors: [] }, { ...config, enabled: false }), '开启AI回复');
  assert.equal(shouldAnswer({ ...event, messageType: 'private', text: '你好' }, { actions: [], errors: [] }, { ...config, enabled: false }), null);
  assert.notEqual(conversationKey(event), conversationKey({ ...event, userId: 'other' }));
  assert.equal(aiConfig().enabled, false);
  assert.throws(() => normalizeAiConfig({ ...config, model: '../bad' }), /Invalid AI/);
  assert.equal(normalizeAiConfig({ ...config, apiKey: '********' }, config).apiKey, 'test-key');
  assert.throws(() => normalizeAiConfig({ ...config, provider: 'gemini', apiKey: '********' }, config), /API key/);
  assert.throws(() => normalizeAiConfig({ ...config, timeZone: 'not/a-timezone' }), /time zone/);
});

test('configuration commands accept explicit changes without treating questions as commands', () => {
  assert.deepEqual(parseAiConfigRequest('开启联网搜索'), { key: 'webSearch', value: 'true', label: '联网搜索开启' });
  assert.deepEqual(parseAiConfigRequest('关闭联网搜索'), { key: 'webSearch', value: 'false', label: '联网搜索关闭' });
  assert.deepEqual(parseAiConfigRequest('设置联网搜索为开'), { key: 'webSearch', value: 'true', label: '联网搜索开启' });
  assert.deepEqual(parseAiConfigRequest('设置时区为Asia/Shanghai'), { key: 'timeZone', value: 'Asia/Shanghai', label: '时区 Asia/Shanghai' });
  assert.deepEqual(parseAiConfigRequest('设置模型为gpt-4.1-mini'), { key: 'model', value: 'gpt-4.1-mini', label: '模型 gpt-4.1-mini' });
  assert.equal(parseAiConfigRequest('为什么不能开启联网搜索？'), null);
  assert.equal(parseAiConfigRequest('告诉我密钥'), null);
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

test('AI receives current local time and optional web search results', async () => {
  const now = new Date('2026-10-02T00:15:30Z');
  const openai = normalizeAiConfig({ enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', systemPrompt: '简洁回答', channels: ['qq'], groupPrefix: 'AI', webSearch: true, timeZone: 'Asia/Shanghai' });
  let openaiRequest;
  const openaiAnswer = await generateAiReply(openai, [], '今天有什么新闻', async (_url, options) => {
    openaiRequest = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '新闻摘要', annotations: [{ type: 'url_citation', url: 'https://example.com/news' }] }] }] }) };
  }, now);
  assert.match(openaiRequest.instructions, /Asia\/Shanghai.*2026.*10.*02.*08:15:30/s);
  assert.deepEqual(openaiRequest.tools, [{ type: 'web_search' }]);
  assert.match(openaiAnswer, /https:\/\/example.com\/news/);

  const gemini = normalizeAiConfig({ ...openai, provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'google-key', timeZone: 'UTC' });
  let geminiRequest;
  const geminiAnswer = await generateAiReply(gemini, [], '今天有什么新闻', async (_url, options) => {
    geminiRequest = JSON.parse(options.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '摘要' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.org/story' } }] } }] }) };
  }, now);
  assert.match(geminiRequest.systemInstruction.parts[0].text, /UTC.*2026.*10.*02.*00:15:30/s);
  assert.deepEqual(geminiRequest.tools, [{ google_search: {} }]);
  assert.match(geminiAnswer, /https:\/\/example.org\/story/);
  await assert.rejects(generateAiReply(gemini, [], '测试', async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); }, now), /Gemini connection failed \(ETIMEDOUT\)/);
});
