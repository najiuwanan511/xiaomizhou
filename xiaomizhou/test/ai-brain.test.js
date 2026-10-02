import assert from 'node:assert/strict';
import test from 'node:test';
import { aiConfig, createAiSessions, conversationKey, generateAiReply, normalizeAiConfig, parseAiConfigRequest } from '../ai-brain.js';

test('AI sessions wake, isolate users, exit, expire and reset context without model calls', () => {
  let time = 1000;
  const sessions = createAiSessions({ clock: () => time });
  const config = aiConfig({ enabled: true, apiKey: 'fake', groupPrefix: 'AI', idleMinutes: 5 });
  const event = { channel: 'qq', messageType: 'group', chatId: 'a', userId: 'b' };
  const route = (text, extra = {}, result = { actions: [], errors: [] }) => sessions.route({ ...event, text, ...extra }, result, config);
  assert.equal(route('普通消息'), null);
  assert.equal(route('AIsomething'), null);
  assert.match(route('AI').reply, /已唤醒/);
  const first = route('你好');
  assert.equal(first.prompt, '你好');
  assert.equal(route('你好', { userId: 'other' }), null);
  assert.equal(route('你好', { chatId: 'other' }), null);
  assert.equal(route('你好', { messageType: 'private' }), null);
  assert.equal(route('AI 图片', {}, { actions: [{ type: 'reply' }], errors: [] }), null);
  assert.equal(route('商品链接', {}, { actions: [], errors: [{ plugin: 'Affiliate conversion' }] }), null);
  assert.match(route('', { images: [{ url: 'https://example.com/a.png' }] }).prompt, /图片/);
  time += 299999;
  assert.equal(route('继续').conversation, first.conversation);
  time += 300000;
  assert.equal(route('继续'), null);
  assert.equal(sessions.current(first.key, first.id), false);
  const second = route('AI 新问题');
  assert.notEqual(second.conversation, first.conversation);
  assert.match(route('退出AI').reply, /已退出/);
  assert.equal(sessions.current(second.key, second.id), false);
  assert.equal(route('继续'), null);
  assert.match(route('唤醒AI').reply, /已唤醒/);
  assert.match(route('AI 结束对话').reply, /已退出/);
  const custom = { ...config, exitCommand: '休息' };
  assert.match(sessions.route({ ...event, text: '休息' }, { actions: [], errors: [] }, custom).reply, /已退出/);
  assert.equal(route('AI 私聊', { messageType: 'private' }).prompt, '私聊');
  assert.equal(route('后续', { messageType: 'private' }).prompt, '后续');
  assert.equal(route('群内提问', { channel: 'qqbot' }).prompt, '群内提问');
  sessions.clear();
  assert.equal(route('后续', { messageType: 'private' }), null);
  assert.equal(sessions.route({ ...event, text: 'AI' }, { actions: [], errors: [] }, { ...config, enabled: false }), null);
  assert.equal(sessions.route({ ...event, text: 'AI' }, { actions: [], errors: [] }, { ...config, channels: [] }), null);
});

test('AI session settings validate boundaries and preserve saved values', () => {
  const config = aiConfig({ provider: 'openai', model: 'gpt-4.1-mini' });
  assert.equal(normalizeAiConfig(config).idleMinutes, 5);
  for (const idleMinutes of [0, 121, 1.5, 'bad']) assert.throws(() => normalizeAiConfig({ ...config, idleMinutes }), /空闲超时/);
  for (const exitCommand of ['', 'AI', '唤醒AI', 'x'.repeat(31)]) assert.throws(() => normalizeAiConfig({ ...config, exitCommand }), /退出命令/);
  const { idleMinutes, exitCommand, ...legacy } = config;
  const saved = normalizeAiConfig(legacy, { idleMinutes: 12, exitCommand: '睡觉' });
  assert.equal(saved.idleMinutes, 12);
  assert.equal(saved.exitCommand, '睡觉');
});

test('AI configuration validates credentials and conversation identity', () => {
  const config = normalizeAiConfig({ enabled: true, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', systemPrompt: '简洁回答', channels: ['qq', 'qqbot'], groupPrefix: 'AI' });
  const event = { channel: 'qq', messageType: 'group', chatId: '123', userId: '456', text: 'AI 今天天气' };
  assert.notEqual(conversationKey(event), conversationKey({ ...event, userId: 'other' }));
  assert.equal(aiConfig().enabled, false);
  assert.throws(() => normalizeAiConfig({ ...config, model: '../bad' }), /Invalid AI/);
  assert.equal(normalizeAiConfig({ ...config, apiKey: '********' }, config).apiKey, 'test-key');
  assert.throws(() => normalizeAiConfig({ ...config, provider: 'gemini', apiKey: '********' }, config), /API key/);
  assert.throws(() => normalizeAiConfig({ ...config, timeZone: 'not/a-timezone' }), /time zone/);
});

test('Gemini and OpenAI send downloaded pictures as image input', async () => {
  const picture = { url: 'https://cdn.example.com/product.jpg' };
  const lookup = async () => [{ address: '8.8.8.8' }];
  for (const provider of ['gemini', 'openai']) {
    const config = normalizeAiConfig({ enabled: true, provider, model: provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini', apiKey: 'key', systemPrompt: 'Answer', channels: ['qq'], groupPrefix: 'AI' });
    let payload;
    const fetchImpl = async (url, options) => {
      if (String(url) === picture.url) return { ok: true, headers: { get: name => name === 'content-type' ? 'image/jpeg' : null }, arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff]) };
      payload = JSON.parse(options.body);
      return provider === 'gemini'
        ? { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '一张商品图' }] } }] }) }
        : { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '一张商品图' }] }] }) };
    };
    assert.equal(await generateAiReply(config, [], '识别图片', fetchImpl, new Date(), [picture], lookup), '一张商品图');
    if (provider === 'gemini') assert.equal(payload.contents[0].parts[1].inlineData.data, '/9j/');
    else assert.equal(payload.input[0].content[1].image_url, 'data:image/jpeg;base64,/9j/');
    await assert.rejects(generateAiReply(config, [], '识别图片', fetchImpl, new Date(), [{ url: 'http://127.0.0.1/p.jpg' }], lookup), /public HTTPS/);
    await assert.rejects(generateAiReply(config, [], '识别图片', fetchImpl, new Date(), [picture], async () => [{ address: '192.168.1.1' }]), /public address/);
  }
});

test('AI rejects unsupported and oversized picture downloads', async () => {
  const config = aiConfig({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'key' });
  const picture = [{ url: 'https://cdn.example.com/a.jpg' }];
  const lookup = async () => [{ address: '8.8.8.8' }];
  await assert.rejects(generateAiReply(config, [], '看图', async () => ({ ok: true, headers: { get: () => 'text/html' } }), new Date(), picture, lookup), /Unsupported image format/);
  await assert.rejects(generateAiReply(config, [], '看图', async () => ({ ok: true, headers: { get: name => name === 'content-type' ? 'image/jpeg' : '6000000' } }), new Date(), picture, lookup), /size limit/);
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
