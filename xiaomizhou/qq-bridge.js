import net from 'node:net';
import { createHash, randomInt } from 'node:crypto';
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
    } else if (part?.type === 'json') {
      // Read only known share-card URL fields. Never trust a card's video URL.
      try {
        const raw = part.data?.data;
        if (typeof raw !== 'string' || raw.length > 30000) continue;
        const meta = JSON.parse(raw)?.meta;
        const links = [meta?.news?.jumpUrl, meta?.detail_1?.qqdocurl, meta?.detail_1?.url, meta?.detail_1?.jumpUrl]
          .filter(value => typeof value === 'string').flatMap(videoShareLinks);
        for (const link of [...new Map(links.map(link => [link.url, link])).values()]) {
          text += `\n${link.url}`;
          segments.push({ type: 'text', data: { text: `\n${link.url}` } });
        }
      } catch { /* Other JSON cards are not video shares. */ }
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

export async function oneBotCall(config, action, params, timeoutMs = 10000) {
  const endpoint = new URL(action, config.endpoint.endsWith('/') ? config.endpoint : `${config.endpoint}/`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`);
  const result = await response.json();
  if ((result.status != null && result.status !== 'ok') || (result.retcode != null && result.retcode !== 0)) {
    const detail = String(result.message || result.wording || '').slice(0, 300);
    throw new Error(`OneBot retcode ${result.retcode ?? 'unknown'}${detail ? `；原因：${detail}` : ''}`);
  }
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

export async function sendQqVideo(config, destination, bytes) {
  if (!/^\d+$/.test(destination.id) || !Number.isSafeInteger(Number(destination.id))) throw new Error('Invalid QQ destination');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('视频文件为空或超过 50 MB');
  // Base64 works with bundled and separately deployed NapCat, without sharing paths
  // or asking NapCat to download an unchecked, sender-controlled URL.
  return oneBotCall(config, destination.type === 'group' ? 'send_group_msg' : 'send_private_msg', {
    [destination.type === 'group' ? 'group_id' : 'user_id']: Number(destination.id),
    message: [{ type: 'video', data: { file: `base64://${bytes.toString('base64')}`, name: 'video.mp4' } }],
    auto_escape: false
  }, 120000);
}

const videoPlatforms = {
  douyin: { name: '抖音', pages: ['douyin.com', 'iesdouyin.com', 'amemv.com'], media: ['douyinvod.com', 'douyin.com', 'iesdouyin.com', 'amemv.com', 'zjcdn.com', 'bytecdn.cn', 'bytedance.com', 'byteimg.com', 'pstatp.com'] },
  kuaishou: { name: '快手', pages: ['kuaishou.com', 'gifshow.com'], media: ['kwimgs.com', 'kwaicdn.com', 'kscdn.com', 'kuaishou.com', 'gifshow.com'] },
  pipixia: { name: '皮皮虾', pages: ['pipix.com', 'pipixia.com'], media: ['ixigua.com', 'pstatp.com', 'bytecdn.cn', 'byteimg.com', 'pipix.com'] }
};
const videoUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1';
const hostIn = (host, domains) => domains.some(domain => host === domain || host.endsWith(`.${domain}`));

export function parseVideoConfig(input = {}, saved = {}) {
  const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('视频解析设置必须为对象');
  for (const key of ['enabled', 'privateEnabled']) if (input[key] != null && typeof input[key] !== 'boolean') bad('视频解析开关必须为布尔值');
  const platforms = input.platforms ?? Object.keys(videoPlatforms);
  const groupIds = input.groupIds ?? [];
  const maxSizeMB = input.maxSizeMB ?? 20;
  const douyinCookie = input.douyinCookie === '********' ? saved.douyinCookie || '' : input.douyinCookie ?? saved.douyinCookie ?? '';
  if (!Array.isArray(platforms) || !platforms.length || platforms.some(key => !Object.hasOwn(videoPlatforms, key))) bad('请选择抖音、快手或皮皮虾');
  if (!Array.isArray(groupIds) || groupIds.length > 100 || groupIds.some(id => typeof id !== 'string' || !/^\d{1,20}$/.test(id))) bad('允许的群号最多 100 个，只能填写数字');
  if (!Number.isInteger(maxSizeMB) || maxSizeMB < 1 || maxSizeMB > 50) bad('视频大小上限为 1–50 MB');
  if (typeof douyinCookie !== 'string' || douyinCookie.length > 16000 || /[\r\n\u0000]/.test(douyinCookie)) bad('抖音 Cookie 格式不正确');
  return { enabled: input.enabled === true, privateEnabled: input.privateEnabled !== false, platforms: [...new Set(platforms)], groupIds: [...new Set(groupIds)], maxSizeMB, douyinCookie: douyinCookie.trim() };
}

export function videoShareLinks(text) {
  const result = new Map();
  for (const match of String(text || '').slice(0, 30000).matchAll(/https?:\/\/[^\s<>"'，。！？、（）【】]+/gi)) {
    const value = match[0].replace(/&amp;/g, '&').replace(/[),.;!?\]}]+$/, '');
    const safe = qqImageUrl(value);
    if (!safe) continue;
    const url = new URL(safe);
    const platform = Object.keys(videoPlatforms).find(key => hostIn(url.hostname, videoPlatforms[key].pages));
    if (!platform) continue;
    const supported = platform === 'douyin'
      ? /^(?:v\.|www\.iesdouyin\.)/.test(url.hostname) && url.pathname !== '/' || /\/(?:share\/)?video\/\d+/.test(url.pathname) || /^\d+$/.test(url.searchParams.get('modal_id') || '')
      : platform === 'kuaishou'
      ? url.hostname === 'v.kuaishou.com' && url.pathname !== '/' || /\/(?:short-video|fw\/(?:photo|long-video)|f)\/[^/]+/.test(url.pathname)
      : /\/(?:s|item|ppx\/item)\/[^/]+/.test(url.pathname);
    if (supported) result.set(url.href, { platform, url: url.href });
  }
  return [...result.values()];
}

export function videoRequests(event, config) {
  if (!config.enabled || event.channel !== 'qq' || event.hasForward) return [];
  if (event.messageType === 'private' ? !config.privateEnabled : event.messageType !== 'group' || config.groupIds.length && !config.groupIds.includes(event.chatId)) return [];
  return videoShareLinks(event.text).filter(link => config.platforms.includes(link.platform)).slice(0, 1);
}

function checkedVideoUrl(value, platform, media = false) {
  const safe = qqImageUrl(value);
  if (!safe || !videoPlatforms[platform]) throw new Error('视频链接格式不受支持');
  const url = new URL(safe);
  if (!hostIn(url.hostname, videoPlatforms[platform][media ? 'media' : 'pages'])) throw new Error('平台返回了不受信任的链接，已停止解析');
  if (media && /playwm|watermark(?:=|%3D)(?:1|true)|[\/_-]watermark[\/_.-]/i.test(url.href)) throw new Error('平台只返回了带水印的视频，本次不发送');
  return url.href;
}

async function videoFetch(url, platform, fetcher, signal, media = false) {
  let current = url;
  for (let hops = 0; hops <= 5; hops++) {
    current = checkedVideoUrl(current, platform, media);
    const response = await fetcher(current, {
      headers: { 'User-Agent': videoUserAgent, Referer: `https://${videoPlatforms[platform].pages[0]}/`, Accept: media ? 'video/*,application/octet-stream;q=0.9' : 'text/html,application/json' },
      redirect: 'manual', signal
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('平台跳转缺少目标地址');
      current = new URL(location, current).href;
      if (!media && platform === 'kuaishou') current = current.replace('/fw/long-video/', '/fw/photo/');
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`平台请求失败（HTTP ${response.status}）`); }
    return { response, url: current };
  }
  throw new Error('平台跳转次数过多');
}

async function videoBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('文件超过设置的大小上限'); }
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('平台返回了空文件');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('文件超过设置的大小上限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Share pages contain JSON assignments, not trusted executable JavaScript.
// Scan the JSON object's boundary and parse it without evaluating page scripts.
function pageJson(html, name) {
  const start = new RegExp(`(?:window\\.)?${name}\\s*=`).exec(html);
  if (!start) return null;
  const offset = start.index + start[0].length;
  const rest = html.slice(offset).trimStart();
  if (rest[0] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < rest.length; index++) {
    const char = rest[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) {
      try { return JSON.parse(rest.slice(0, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function firstVideoUrl(address) {
  const list = address?.url_list || address;
  if (!Array.isArray(list)) return '';
  return list.map(item => typeof item === 'string' ? item : item?.url).find(value => typeof value === 'string' && value) || '';
}

export function videoMetadata(platform, source, htmlOrJson) {
  let title, videoUrl, id;
  if (platform === 'douyin') {
    const data = typeof htmlOrJson === 'string' ? pageJson(htmlOrJson, '_ROUTER_DATA') : htmlOrJson;
    const item = data?.aweme_detail || Object.values(data?.loaderData || {}).flatMap(value => value?.videoInfoRes?.item_list || []).find(item => item?.video);
    if (item?.images?.length) throw new Error('这是图文作品，当前只解析视频');
    title = item?.desc; id = String(item?.aweme_id || '');
    videoUrl = firstVideoUrl(item?.video?.play_addr).replace(/\/playwm\//, '/play/');
    if (item?.video?.has_watermark === true) throw new Error('未取得无水印原片，本次不发送');
  } else if (platform === 'kuaishou') {
    const data = pageJson(String(htmlOrJson), 'INIT_STATE');
    const detail = Object.values(data || {}).find(value => value?.photo && value?.result != null);
    const photo = detail?.result === 1 ? detail.photo : null;
    title = photo?.caption; id = String(photo?.id || photo?.photoId || '');
    videoUrl = firstVideoUrl(photo?.mainMvUrls);
    if (photo?.watermark === true) throw new Error('未取得无水印原片，本次不发送');
  } else if (platform === 'pipixia') {
    const item = htmlOrJson?.data?.item || htmlOrJson?.data?.cell_comments?.[0]?.comment_info?.item;
    title = item?.content; id = String(item?.item_id || item?.id || '');
    // The ordinary video_high address can be watermarked. Only use an explicitly
    // clean/original rendition; never substitute another video from the comments.
    const video = item?.video;
    const original = video?.video_origin || video?.video_original;
    const clean = original || (video?.has_watermark === false || video?.video_high?.has_watermark === false ? video?.video_high : null);
    videoUrl = firstVideoUrl(clean);
    if (video && !videoUrl) throw new Error('皮皮虾未提供可确认的无水印原片，本次不发送');
  }
  if (typeof title !== 'string' || !title.trim() || !videoUrl) throw new Error('未取得视频和原平台标题，链接可能失效、需要登录或平台已改版');
  return { platform, platformName: videoPlatforms[platform].name, source, id, title: title.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 4000), url: checkedVideoUrl(videoUrl, platform, true) };
}

// Request signing adapted from wujunwei928/parse-video (MIT). See
// third-party/parse-video-LICENSE.txt. Cookies stay on the fixed Douyin endpoint.
/* MIT License
Copyright (c) 2022 wujunwei928

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export function douyinDetailRequest(id, now = Date.now(), random = () => randomInt(10000)) {
  const query = new URLSearchParams({
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1', version_code: '290100', version_name: '29.1.0', cookie_enabled: 'true',
    screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '130.0.0.0', browser_online: 'true',
    engine_name: 'Blink', engine_version: '130.0.0.0', os_name: 'Windows', os_version: '10', cpu_core_num: '12', device_memory: '8', platform: 'PC', downlink: '10',
    effective_type: '4g', from_user_page: '1', locate_query: 'false', need_time_list: '1', pc_libra_divert: 'Windows', publish_video_strategy_type: '2', round_trip_time: '0',
    show_live_replay_strategy: '1', time_list_query: '0', whale_cut_token: '', update_version_code: '170400', msToken: '', aweme_id: id
  }).toString();
  const hash = value => createHash('sm3').update(createHash('sm3').update(value).digest()).digest();
  const params = hash(query + 'cus'), method = hash('GETcus');
  const ua = [76, 98, 15, 131, 97, 245, 224, 133, 122, 199, 241, 166, 79, 34, 90, 191, 128, 126, 122, 98, 66, 11, 14, 40, 49, 110, 110, 173, 67, 96, 138, 252];
  const browser = '1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|MacIntel';
  const finished = now + 4 + random() % 5;
  const byte = (time, shift) => Math.floor(time / 2 ** shift) & 255;
  const payload = [44, byte(finished, 24), 0, 0, 0, 0, 24, params[21], method[21], 0, ua[23], byte(finished, 16), 0, 0, 0, 1, 0, 239, params[22], method[22], ua[24], byte(finished, 8), 0, 0, 0, 0, byte(finished, 0), 0, 0, 14, byte(now, 24), byte(now, 16), 0, byte(now, 8), 3, Math.floor(finished / 2 ** 32), 1, Math.floor(now / 2 ** 32), 1, browser.length, 0, 0, 0];
  const checksum = payload.reduce((value, part) => value ^ part, 0);
  payload.push(...[...browser].map(char => char.charCodeAt(0)), checksum);
  const group = (value, a, b, c, d) => [(value & 170) | a, (value & 85) | b, (value >> 8 & 170) | c, (value >> 8 & 85) | d];
  const prefix = [...group(random(), 1, 2, 5, 45 & 170), ...group(random(), 1, 0, 0, 0), ...group(random(), 1, 0, 5, 0)];
  const state = Array.from({ length: 256 }, (_, index) => index);
  let position = 0;
  for (let index = 0; index < 256; index++) {
    position = (position + state[index] + 121) % 256;
    [state[index], state[position]] = [state[position], state[index]];
  }
  position = 0;
  const values = [...prefix, ...payload.map((value, offset) => {
    const index = (offset + 1) % 256;
    position = (position + state[index]) % 256;
    [state[index], state[position]] = [state[position], state[index]];
    return state[(state[index] + state[position]) & 255] ^ value;
  })];
  const alphabet = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
  let signature = '';
  for (let index = 0; index < values.length; index += 3) {
    const number = values[index] << 16 | (values[index + 1] || 0) << 8 | (values[index + 2] || 0);
    signature += alphabet[number >> 18 & 63] + alphabet[number >> 12 & 63];
    if (index + 1 < values.length) signature += alphabet[number >> 6 & 63];
    if (index + 2 < values.length) signature += alphabet[number & 63];
  }
  signature = signature.padEnd(Math.ceil(signature.length / 4) * 4, '=');
  return `https://www.douyin.com/aweme/v1/web/aweme/detail/?${query}&a_bogus=${encodeURIComponent(signature)}`;
}

async function douyinDetail(id, source, cookie, fetcher, signal) {
  const response = await fetcher(douyinDetailRequest(id), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36', Referer: 'https://www.douyin.com/', 'Accept-Language': 'zh-CN,zh;q=0.8', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'error', signal
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`抖音详情请求失败（HTTP ${response.status}）`); }
  let data;
  const text = (await videoBytes(response, 4 * 1024 * 1024)).toString('utf8');
  try { data = JSON.parse(text); } catch { /* A challenge may return an empty body. */ }
  if (String(data?.aweme_detail?.aweme_id || '') !== id) throw new Error(cookie ? '抖音详情接口未返回作品，请更新网页 Cookie 或稍后重试' : '抖音分享页没有返回视频数据，请在视频解析设置中填写有效的抖音网页 Cookie 后重试');
  return videoMetadata('douyin', source, data);
}

export async function resolveVideo(link, fetcher = fetch, options = {}) {
  const { platform } = link;
  const signal = AbortSignal.timeout(30000);
  let page = await videoFetch(link.url, platform, fetcher, signal);
  const html = (await videoBytes(page.response, 4 * 1024 * 1024)).toString('utf8');
  if (platform === 'pipixia') {
    const id = /\/(?:ppx\/)?item\/(\d+)/.exec(new URL(page.url).pathname)?.[1];
    if (!id) throw new Error('皮皮虾分享链接已失效或无法识别作品编号');
    page = await videoFetch(`https://api.pipix.com/bds/cell/cell_comment/?offset=0&cell_type=1&api_version=1&cell_id=${id}&ac=wifi&channel=huawei_1319_64&aid=1319&app_name=super`, platform, fetcher, signal);
    let data;
    try { data = JSON.parse((await videoBytes(page.response, 4 * 1024 * 1024)).toString('utf8')); } catch { throw new Error('皮皮虾未返回有效作品数据'); }
    return videoMetadata(platform, link.url, data);
  }
  if (platform === 'douyin') {
    const resolved = new URL(page.url);
    const original = new URL(link.url);
    const id = /\/(?:share\/)?video\/(\d+)/.exec(resolved.pathname)?.[1] || resolved.searchParams.get('modal_id') || /\/(?:share\/)?video\/(\d+)/.exec(original.pathname)?.[1] || original.searchParams.get('modal_id');
    try {
      const metadata = videoMetadata(platform, link.url, html);
      if (id && metadata.id !== id) throw new Error('作品编号与分享链接不一致');
      return metadata;
    } catch (error) { if (error.message.includes('图文作品') || error.message.includes('水印')) throw error; }
    if (id && /^\d+$/.test(id)) {
      return douyinDetail(id, link.url, options.douyinCookie || '', fetcher, signal);
    }
  }
  return videoMetadata(platform, link.url, html);
}

export async function downloadVideo(metadata, maxSizeMB, fetcher = fetch) {
  const { response } = await videoFetch(metadata.url, metadata.platform, fetcher, AbortSignal.timeout(60000), true);
  const type = response.headers.get('content-type') || '';
  if (!/^(video\/|application\/octet-stream)/i.test(type)) { await response.body?.cancel(); throw new Error('平台没有返回视频文件，可能需要验证或链接已过期'); }
  const bytes = await videoBytes(response, maxSizeMB * 1024 * 1024);
  // MP4/QuickTime and WebM signatures. Never pass an HTML login page to QQ.
  if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp' && bytes.readUInt32BE(0) !== 0x1a45dfa3) throw new Error('返回的文件不是受支持的视频格式');
  return bytes;
}
