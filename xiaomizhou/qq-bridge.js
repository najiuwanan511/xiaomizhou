import net from 'node:net';
import { normalizeShareText } from './rebate-automation.js';

// Never accept a sender-supplied local file path, base64 payload or private host.
export function qqImageUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2000) return null;
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ['http:', 'https:'].includes(url.protocol) && host.includes('.') && !url.username && !url.password && !url.port && !net.isIP(host) && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local') ? url.href : null;
  } catch { return null; }
}

const decodeCq = value => value.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
export function qqMessageParts(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  const text = String(value ?? '');
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset) parts.push({ type: 'text', data: { text: decodeCq(text.slice(offset, match.index)) } });
    const data = Object.fromEntries(match[2].split(',').filter(Boolean).map(field => {
      const at = field.indexOf('=');
      return [field.slice(0, at), decodeCq(field.slice(at + 1))];
    }));
    parts.push({ type: match[1], data });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ type: 'text', data: { text: decodeCq(text.slice(offset)) } });
  return parts;
}

export function qqMessageContent(value) {
  const segments = [];
  const images = [];
  let text = '';
  for (const part of qqMessageParts(value)) {
    if (part?.type === 'text') {
      const content = String(part.data?.text ?? '');
      text += content;
      segments.push({ type: 'text', data: { text: content } });
    } else if (part?.type === 'image') {
      const url = qqImageUrl(part.data?.url) || qqImageUrl(part.data?.file);
      if (url) {
        images.push({ url, mimeType: 'image/jpeg' });
        segments.push({ type: 'image', data: { file: url } });
      }
    } else if (part?.type === 'share') {
      const url = qqImageUrl(part.data?.url);
      if (url) {
        const content = [String(part.data?.title || '').slice(0, 200), url].filter(Boolean).join('\n');
        text += content;
        segments.push({ type: 'text', data: { text: content } });
      }
    }
  }
  if (text.length > 4000 || images.length > 10 || segments.length > 100) throw new Error('QQ 单条消息超过限制：最多 4000 字、10 张图片、100 个消息段');
  return { text, images, segments };
}

export function oneBotEvent(input) {
  if (input?.post_type !== 'message' || !['private', 'group'].includes(input.message_type)) return null;
  const userId = String(input.user_id ?? '');
  const chatId = String(input.message_type === 'group' ? input.group_id ?? '' : input.user_id ?? '');
  const messageId = String(input.message_id ?? '');
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(chatId) || !messageId || messageId.length > 120) return null;
  if (userId === String(input.self_id ?? '')) return null;
  const parts = qqMessageParts(input.message ?? input.raw_message);
  const content = qqMessageContent(parts);
  const hasForward = parts.some(part => ['forward', 'node'].includes(part?.type));
  if (!content.text.trim() && !content.images.length && !hasForward) return null;
  return { channel: 'qq', chatId, userId, ...content, parts, hasForward, messageType: input.message_type, messageId, deliveryKey: `${input.self_id ?? ''}:${input.message_type}:${chatId}:${messageId}` };
}

// Fail the whole expansion before sending on malformed/expired records or limits.
// This prevents a retry from shifting delivery indexes and duplicating earlier nodes.
export async function expandQqForward(event, config, call = oneBotCall) {
  const messages = [];
  const cache = new Map();
  const active = new Set();
  let calls = 0;
  let visited = 0;
  function append(parts) {
    const content = qqMessageContent(parts);
    if (!content.text.trim() && !content.images.length) return;
    messages.push(content);
    if (messages.length > 50) throw new Error('合并消息超过 50 条，请拆成更小的聊天记录');
  }
  async function walk(value, depth = 0) {
    if (depth > 3) throw new Error('合并消息嵌套超过 3 层');
    let pending = [];
    for (const part of qqMessageParts(value)) {
      if (++visited > 1000) throw new Error('合并消息内容过多');
      if (!['forward', 'node'].includes(part?.type)) { pending.push(part); continue; }
      append(pending); pending = [];
      if (part.type === 'node') {
        const data = part.data || {};
        // NapCat may return both content:[] and message:[...].
        const content = Array.isArray(data.message) && data.message.length ? data.message : data.content ?? data.message;
        if (content == null) throw new Error('合并节点缺少正文');
        await walk(content, depth);
        continue;
      }
      const data = part.data || {};
      if (Array.isArray(data.content) && data.content.length) {
        for (const node of data.content) await walk(node.message ?? node.content ?? node, depth + 1);
        continue;
      }
      const id = String(data.id ?? '');
      if (!id || id.length > 256) throw new Error('合并消息缺少有效的记录 ID');
      if (active.has(id)) throw new Error('合并消息包含循环引用');
      active.add(id);
      try {
        if (!cache.has(id)) {
          if (++calls > 10) throw new Error('合并消息引用超过 10 个记录');
          const response = await call(config, 'get_forward_msg', { message_id: id, id });
          const nodes = response?.messages ?? response?.message;
          if (!Array.isArray(nodes) || !nodes.length) throw new Error('NapCat 未返回合并消息正文，记录可能已失效');
          cache.set(id, nodes);
        }
        for (const node of cache.get(id)) await walk(node.type === 'node' ? [node] : node.content ?? node.message, depth + 1);
      } finally { active.delete(id); }
    }
    append(pending);
  }
  await walk(event.parts);
  if (!messages.length) throw new Error('合并消息中没有可发送的文字或图片');
  return messages;
}

export function validateForwardContent(input = {}) {
  const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('内容处理配置必须为对象');
  const keywords = input.blockedKeywords ?? [];
  const replacements = input.replacements ?? [];
  if (!Array.isArray(keywords) || keywords.length > 50 || keywords.some(word => typeof word !== 'string' || !word.trim() || word.trim().length > 100)) bad('禁止关键词最多 50 个，每个为 1–100 字');
  if (input.ignoreCase != null && typeof input.ignoreCase !== 'boolean') bad('关键词忽略大小写开关必须为布尔值');
  if (!Array.isArray(replacements) || replacements.length > 20) bad('文字或链接替换最多 20 条');
  const rows = replacements.map(row => {
    if (!row || typeof row !== 'object' || typeof row.find !== 'string' || !row.find.trim() || row.find.length > 500 || typeof row.replace !== 'string' || row.replace.length > 1000) bad('替换原文须为 1–500 字，替换内容最多 1000 字，可留空删除');
    return { find: row.find, replace: row.replace };
  });
  return { blockedKeywords: [...new Set(keywords.map(word => word.trim()))], ignoreCase: input.ignoreCase !== false, replacements: rows };
}

export function forwardContentConfig(rule) {
  return validateForwardContent(rule.contentRules ?? JSON.parse(rule.content_rules || '{}'));
}

export function blockedForwardKeyword(text, config) {
  const normalize = value => {
    const result = normalizeShareText(value).normalize('NFKC');
    return config.ignoreCase ? result.toLowerCase() : result;
  };
  const haystack = normalize(String(text || ''));
  return config.blockedKeywords.find(word => haystack.includes(normalize(word))) || null;
}

// Literal edits are applied to the joined text, then mapped back into text segments.
// Images remain in place even when a match spans multiple text segments.
function replaceForwardText(text, segments, row) {
  const edits = [];
  let at = 0;
  while ((at = text.indexOf(row.find, at)) !== -1) { edits.push({ start: at, end: at + row.find.length }); at += row.find.length; }
  if (!edits.length) return { text, segments, count: 0 };
  if (text.length + edits.length * (row.replace.length - row.find.length) > 4000) return { overflow: true };
  const output = text.split(row.find).join(row.replace);
  let offset = 0;
  const mapped = segments?.map(segment => {
    if (segment.type !== 'text') return segment;
    const value = segment.data.text;
    const start = offset;
    const end = start + value.length;
    offset = end;
    let cursor = start;
    let replaced = '';
    for (const edit of edits) {
      if (edit.end <= start || edit.start >= end) continue;
      if (edit.start > cursor) replaced += value.slice(cursor - start, edit.start - start);
      if (edit.start >= start) replaced += row.replace;
      cursor = Math.max(cursor, Math.min(edit.end, end));
    }
    replaced += value.slice(cursor - start);
    return { type: 'text', data: { text: replaced } };
  }).filter(segment => segment.type !== 'text' || segment.data.text);
  return { text: output, segments: mapped, count: edits.length };
}

export function processForwardContent(message, config, sourceText = message.text) {
  const keyword = blockedForwardKeyword(sourceText, config);
  if (keyword) return { blocked: true, reason: 'source-keyword', keyword, text: message.text, replacements: 0 };
  let text = String(message.text || '');
  let segments = message.segments;
  if (segments?.filter(part => part.type === 'text').map(part => part.data.text).join('') !== text) segments = undefined;
  let replacements = 0;
  for (const row of config.replacements) {
    const output = replaceForwardText(text, segments, row);
    if (output.overflow) return { blocked: true, reason: 'too-long', text, replacements };
    text = output.text; segments = output.segments; replacements += output.count;
  }
  if (text.length > 4000) return { blocked: true, reason: 'too-long', text, replacements };
  const finalKeyword = blockedForwardKeyword(text, config);
  if (finalKeyword) return { blocked: true, reason: 'output-keyword', keyword: finalKeyword, text, replacements };
  if (!text.trim() && !message.images?.length) return { blocked: true, reason: 'empty', text, replacements };
  return { blocked: false, text, segments, replacements };
}

export function finalizeForwardActions(result, onCheck = () => {}) {
  result.actions = result.actions.flatMap(action => {
    if (action.type !== 'forward' || !action.contentRules) return [action];
    const processed = processForwardContent(action, action.contentRules, action.sourceText);
    onCheck(action, processed);
    if (processed.blocked) return [];
    const { sourceText, contentRules, ...outgoing } = action;
    outgoing.text = processed.text;
    if (processed.segments?.length) outgoing.segments = processed.segments;
    else delete outgoing.segments;
    return [outgoing];
  });
  return result;
}

export function qqForwardActions(event, rule, onBlock = () => {}) {
  if (rule.source_channel !== event.channel || rule.source_chat_id !== event.chatId) return [];
  // Sending back into the source conversation has no useful forwarding effect.
  if (rule.target_channel === event.channel && rule.target === `${event.messageType}:${event.chatId}`) return [];
  const contentRules = forwardContentConfig(rule);
  const messages = event.hasForward && rule.split_forward !== 0 ? event.forwardMessages || [] : [event];
  return messages.flatMap((message, index) => {
    const keyword = blockedForwardKeyword(message.text, contentRules);
    if (keyword) { onBlock({ ruleId: rule.id, nodeIndex: index, keyword }); return []; }
    if (rule.mode === 'links' && !/https?:\/\/\S+/i.test(normalizeShareText(message.text))) return [];
    const images = rule.include_images !== 0 ? message.images || [] : [];
    if (!message.text.trim() && !images.length) return [];
    const segments = message.segments?.filter(segment => segment.type !== 'image' || rule.include_images !== 0);
    return [{ type: 'forward', channel: rule.target_channel, target: rule.target, text: message.text, sourceText: message.text, contentRules, images, ...(rule.target_channel === 'qq' && segments?.length ? { segments } : {}), deliveryId: `rule:${rule.id}:node:${index}`, delayMs: rule.send_interval ?? 1000, plugin: `Rule #${rule.id}` }];
  });
}

// One callback batch at a time: nodes from two concurrent records never interleave.
export function createQqBatchQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return task => {
    if (pending >= 100) return Promise.reject(new Error('QQ 转发队列已满，请稍后重试'));
    pending++;
    const result = tail.then(task);
    tail = result.catch(() => {}).finally(() => { pending--; });
    return result;
  };
}

export function qqDestination(action, event) {
  if (action.type === 'reply') return { type: event.messageType, id: event.chatId };
  if (action.type !== 'forward' || action.channel !== 'qq') return null;
  const match = /^(group|private):(\d+)$/.exec(action.target);
  return match ? { type: match[1], id: match[2] } : null;
}

export async function oneBotCall(config, action, params) {
  const endpoint = new URL(action, config.endpoint.endsWith('/') ? config.endpoint : `${config.endpoint}/`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`);
  const result = await response.json();
  if ((result.status != null && result.status !== 'ok') || (result.retcode != null && result.retcode !== 0)) throw new Error(`OneBot retcode ${result.retcode ?? 'unknown'}`);
  return result.data;
}

export async function sendQq(config, destination, text, images = [], segments = null) {
  if (!/^\d+$/.test(destination.id) || !Number.isSafeInteger(Number(destination.id))) throw new Error('Invalid QQ destination');
  const safeImages = images.map(image => qqImageUrl(image?.url)).filter(Boolean).slice(0, 10);
  const ordered = segments ? qqMessageContent(segments).segments : null;
  const params = ordered?.length
    ? { message: ordered, auto_escape: false }
    : safeImages.length
    ? { message: [...(text ? [{ type: 'text', data: { text: String(text).slice(0, 4000) } }] : []), ...safeImages.map(url => ({ type: 'image', data: { file: url } }))], auto_escape: false }
    : { message: String(text).slice(0, 4000), auto_escape: true };
  params[destination.type === 'group' ? 'group_id' : 'user_id'] = Number(destination.id);
  return oneBotCall(config, destination.type === 'group' ? 'send_group_msg' : 'send_private_msg', params);
}
