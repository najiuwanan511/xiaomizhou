export const aiChannels = ['qq', 'qqbot', 'wecom'];
const defaults = { enabled: false, provider: 'openai', model: 'gpt-4.1-mini', apiKey: '', systemPrompt: '你是 xiaomizhou 的助手。用中文简洁回答。你不能执行提醒、修改配置或修复接口；没有实际执行时，不要声称已经完成。不要编造返利链接。', channels: ['qq', 'qqbot', 'wecom'], groupPrefix: 'AI ' };

export function normalizeAiConfig(input, previous = {}) {
  const provider = input.provider === 'gemini' ? 'gemini' : input.provider === 'openai' ? 'openai' : null;
  const model = String(input.model || '').trim();
  const apiKey = input.apiKey === '********' && provider === previous.provider ? previous.apiKey || '' : String(input.apiKey === '********' ? '' : input.apiKey || '').trim();
  const systemPrompt = String(input.systemPrompt || '').trim();
  const channels = Array.isArray(input.channels) ? [...new Set(input.channels.filter(value => aiChannels.includes(value)))] : [];
  const groupPrefix = String(input.groupPrefix ?? '').trim();
  if (!provider || !/^[a-zA-Z0-9._-]{1,100}$/.test(model) || systemPrompt.length > 4000 || groupPrefix.length > 30) throw Object.assign(new Error('Invalid AI provider, model or prompt'), { status: 400 });
  if (input.enabled && (!apiKey || !channels.length)) throw Object.assign(new Error('API key and at least one channel required'), { status: 400 });
  if (input.enabled && channels.includes('qq') && !groupPrefix) throw Object.assign(new Error('QQ group prefix required'), { status: 400 });
  return { enabled: input.enabled === true, provider, model, apiKey, systemPrompt, channels, groupPrefix };
}

export function aiConfig(stored = {}) {
  return { ...defaults, ...stored, channels: Array.isArray(stored.channels) ? stored.channels : defaults.channels };
}

export function shouldAnswer(event, result, config) {
  if (!config.enabled || !config.apiKey || !config.channels.includes(event.channel) || !String(event.text || '').trim()) return null;
  if (result.actions.some(action => action.type === 'reply' || action.type === 'blocked')) return null;
  if (result.errors.some(error => error.plugin === 'Affiliate conversion')) return null;
  let text = event.text.trim();
  if (event.channel === 'qq' && event.messageType === 'group') {
    if (!text.startsWith(config.groupPrefix)) return null;
    const rest = text.slice(config.groupPrefix.length);
    if (rest && !/^[\s:：，,]/u.test(rest)) return null;
    text = rest.replace(/^[\s:：，,]+/u, '').trim();
  }
  return text || null;
}

export function conversationKey(event) {
  return JSON.stringify([event.channel, event.messageType || 'private', event.chatId, event.userId]);
}

function responseText(value) {
  let output = '';
  let bytes = 0;
  for (const char of String(value || '').trim()) {
    const size = Buffer.byteLength(char, 'utf8');
    if (output.length >= 600 || bytes + size > 1800) break;
    output += char;
    bytes += size;
  }
  return output;
}

export async function generateAiReply(config, history, text, fetchImpl = fetch) {
  const messages = [...history.flatMap(turn => [{ role: 'user', content: turn.user_text }, { role: 'assistant', content: turn.assistant_text }]), { role: 'user', content: text }];
  const openai = config.provider === 'openai';
  const url = openai ? 'https://api.openai.com/v1/responses' : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const payload = openai
    ? { model: config.model, instructions: config.systemPrompt, input: messages, max_output_tokens: 512, store: false }
    : { systemInstruction: { parts: [{ text: config.systemPrompt }] }, contents: messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })), generationConfig: { maxOutputTokens: 512 } };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(openai ? { Authorization: `Bearer ${config.apiKey}` } : { 'x-goog-api-key': config.apiKey }) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000), redirect: 'error'
  });
  if (!response.ok) throw new Error(`${openai ? 'OpenAI' : 'Gemini'} API HTTP ${response.status}`);
  const data = await response.json();
  const raw = openai
    ? data.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n')
    : data.candidates?.[0]?.content?.parts?.filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
  const answer = responseText(raw);
  if (!answer) throw new Error(`${openai ? 'OpenAI' : 'Gemini'} returned no text`);
  return answer;
}
