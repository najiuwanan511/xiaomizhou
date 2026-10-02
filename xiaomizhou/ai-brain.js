export const aiChannels = ['qq', 'qqbot', 'wecom'];
const defaults = { enabled: false, provider: 'openai', model: 'gpt-4.1-mini', apiKey: '', systemPrompt: '你是 xiaomizhou 的助手。用中文简洁回答。明确的 AI 配置命令可提交管理员审核，不能自行修改配置。你不能执行提醒或修复接口；没有实际执行时，不要声称已经完成。不要编造返利链接。', channels: ['qq', 'qqbot', 'wecom'], groupPrefix: 'AI ', webSearch: false, timeZone: 'Asia/Shanghai' };

export function normalizeAiConfig(input, previous = {}) {
  const provider = input.provider === 'gemini' ? 'gemini' : input.provider === 'openai' ? 'openai' : null;
  const model = String(input.model || '').trim();
  const apiKey = input.apiKey === '********' && provider === previous.provider ? previous.apiKey || '' : String(input.apiKey === '********' ? '' : input.apiKey || '').trim();
  const systemPrompt = String(input.systemPrompt || '').trim();
  const channels = Array.isArray(input.channels) ? [...new Set(input.channels.filter(value => aiChannels.includes(value)))] : [];
  const groupPrefix = String(input.groupPrefix ?? '').trim();
  const timeZone = String(input.timeZone || 'Asia/Shanghai').trim();
  if (!provider || !/^[a-zA-Z0-9._-]{1,100}$/.test(model) || systemPrompt.length > 4000 || groupPrefix.length > 30) throw Object.assign(new Error('Invalid AI provider, model or prompt'), { status: 400 });
  try { if (timeZone.length > 100) throw new RangeError(); new Intl.DateTimeFormat('zh-CN', { timeZone }); }
  catch { throw Object.assign(new Error('Invalid IANA time zone'), { status: 400 }); }
  if (input.enabled && (!apiKey || !channels.length)) throw Object.assign(new Error('API key and at least one channel required'), { status: 400 });
  if (input.enabled && channels.includes('qq') && !groupPrefix) throw Object.assign(new Error('QQ group prefix required'), { status: 400 });
  return { enabled: input.enabled === true, provider, model, apiKey, systemPrompt, channels, groupPrefix, webSearch: input.webSearch === true, timeZone };
}

export function aiConfig(stored = {}) {
  return { ...defaults, ...stored, channels: Array.isArray(stored.channels) ? stored.channels : defaults.channels };
}

export function shouldAnswer(event, result, config) {
  if (!config.apiKey || !config.channels.includes(event.channel) || !String(event.text || '').trim()) return null;
  if (result.actions.some(action => action.type === 'reply' || action.type === 'blocked')) return null;
  if (result.errors.some(error => error.plugin === 'Affiliate conversion')) return null;
  let text = event.text.trim();
  if (event.channel === 'qq' && event.messageType === 'group') {
    if (!text.startsWith(config.groupPrefix)) return null;
    const rest = text.slice(config.groupPrefix.length);
    if (rest && !/^[\s:：，,]/u.test(rest)) return null;
    text = rest.replace(/^[\s:：，,]+/u, '').trim();
  }
  return text && (config.enabled || parseAiConfigRequest(text)) ? text : null;
}

export function conversationKey(event) {
  return JSON.stringify([event.channel, event.messageType || 'private', event.chatId, event.userId]);
}

export function parseAiConfigRequest(text) {
  const command = String(text || '').trim().replace(/[。！!]+$/u, '').trim();
  if (command.length > 120 || /[？?]/u.test(command)) return null;
  const search = /^(?:请)?(?:帮我)?(?:开启|打开|启用|关闭|停用|禁用)(?:AI)?(?:的)?(?:联网搜索|网络搜索)$/u.exec(command);
  const searchObject = /^(?:请)?(?:帮我)?(?:设置|修改|把)?(?:AI)?(?:的)?(?:联网搜索|网络搜索)(?:功能)?(?:设置为|改为|调为|设为|为)?(开|关|开启|关闭|打开|启用|停用|禁用)$/u.exec(command);
  if (search || searchObject) {
    const verb = search ? command : searchObject[1];
    const enabled = /开启|打开|启用|^开$/u.test(verb);
    return { key: 'webSearch', value: String(enabled), label: `联网搜索${enabled ? '开启' : '关闭'}` };
  }
  const timeZone = /^(?:请)?(?:帮我)?(?:设置|修改)(?:AI)?(?:的)?时区(?:为|成|：|:|\s+)\s*([A-Za-z0-9_+/-]{1,100})$/u.exec(command);
  if (timeZone) return { key: 'timeZone', value: timeZone[1], label: `时区 ${timeZone[1]}` };
  const model = /^(?:请)?(?:帮我)?(?:设置|修改)(?:AI)?(?:的)?模型(?:为|成|：|:|\s+)\s*([A-Za-z0-9._-]{1,100})$/u.exec(command);
  if (model) return { key: 'model', value: model[1], label: `模型 ${model[1]}` };
  const enabled = /^(?:请)?(?:帮我)?(开启|打开|启用|关闭|停用|禁用)AI回复$/u.exec(command);
  if (enabled) return { key: 'enabled', value: String(/开启|打开|启用/u.test(enabled[1])), label: `AI 回复${/开启|打开|启用/u.test(enabled[1]) ? '开启' : '关闭'}` };
  return null;
}

function responseText(value, maxBytes = 1800) {
  let output = '';
  let bytes = 0;
  for (const char of String(value || '').trim()) {
    const size = Buffer.byteLength(char, 'utf8');
    if (output.length >= 600 || bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output;
}

export async function generateAiReply(config, history, text, fetchImpl = fetch, now = new Date()) {
  const messages = [...history.flatMap(turn => [{ role: 'user', content: turn.user_text }, { role: 'assistant', content: turn.assistant_text }]), { role: 'user', content: text }];
  const openai = config.provider === 'openai';
  const url = openai ? 'https://api.openai.com/v1/responses' : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const timeZone = config.timeZone || 'Asia/Shanghai';
  const localTime = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now);
  const instructions = `${config.systemPrompt}\n当前时间（${timeZone}）：${localTime}。涉及实时信息时，只有实际完成联网搜索才能说已查询。`;
  const payload = openai
    ? { model: config.model, instructions, input: messages, max_output_tokens: 512, store: false, ...(config.webSearch ? { tools: [{ type: 'web_search' }] } : {}) }
    : { systemInstruction: { parts: [{ text: instructions }] }, contents: messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })), generationConfig: { maxOutputTokens: 512 }, ...(config.webSearch ? { tools: [{ google_search: {} }] } : {}) };
  const providerName = openai ? 'OpenAI' : 'Gemini';
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(openai ? { Authorization: `Bearer ${config.apiKey}` } : { 'x-goog-api-key': config.apiKey }) },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(config.webSearch ? 60000 : 30000), redirect: 'error'
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timeout' : /^[A-Z_]+$/.test(error.cause?.code || '') ? error.cause.code : 'network error';
    throw Object.assign(new Error(`${providerName} connection failed (${reason}); check NAS network or proxy`), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error(`${providerName} API HTTP ${response.status}; check model, key and search permissions`), { status: 502 });
  const data = await response.json();
  const raw = openai
    ? data.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n')
    : data.candidates?.[0]?.content?.parts?.filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
  const references = config.webSearch ? (openai
    ? data.output?.flatMap(item => item.content || []).flatMap(part => part.annotations || []).map(annotation => annotation.url)
    : data.candidates?.[0]?.groundingMetadata?.groundingChunks?.map(chunk => chunk.web?.uri)) : [];
  const sources = [...new Set((references || []).filter(value => {
    try { return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 300 && new URL(value).protocol === 'https:'; }
    catch { return false; }
  }))].slice(0, 2);
  const sourceText = sources.length ? `\n来源：${sources.join(' ')}` : '';
  const answer = responseText(raw, 1800 - Buffer.byteLength(sourceText, 'utf8'));
  if (!answer) throw new Error(`${openai ? 'OpenAI' : 'Gemini'} returned no text`);
  return answer + sourceText;
}
