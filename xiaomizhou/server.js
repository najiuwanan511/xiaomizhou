import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { runPlugin } from './plugin-runner.js';
import { oneBotEvent, qqDestination, oneBotCall, sendQq } from './qq-bridge.js';
import { createQqBotBridge, qqBotDestination } from './qqbot-bridge.js';
import { createWecomBridge, wecomCallback, wecomDestination, wecomEvent } from './wecom-bridge.js';
import { applyRebates, convertOfficial, defaultRebateTemplate, formatRebate, imageUrl, validateRebateTemplate } from './rebate-automation.js';
import { aiConfig, conversationKey, generateAiReply, normalizeAiConfig, parseAiConfigRequest, shouldAnswer } from './ai-brain.js';
import { checkUpdate, installUpdate } from './update-manager.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const port = Number(process.env.PORT || 8090);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
let installingUpdate = false;
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'ownman.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, time TEXT NOT NULL, level TEXT NOT NULL, area TEXT NOT NULL, message TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS qq_deliveries (message_id TEXT NOT NULL, action_index INTEGER NOT NULL, delivered_at TEXT NOT NULL, PRIMARY KEY(message_id, action_index));
  CREATE TABLE IF NOT EXISTS forward_rules (id INTEGER PRIMARY KEY, source_channel TEXT NOT NULL, source_chat_id TEXT NOT NULL, target_channel TEXT NOT NULL, target TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'all', enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS ai_turns (delivery_key TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, user_text TEXT NOT NULL, assistant_text TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ai_turns_conversation ON ai_turns(conversation_key, created_at DESC);
  CREATE TABLE IF NOT EXISTS ai_config_proposals (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT NOT NULL, setting_key TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
`);

const q = {
  users: db.prepare('SELECT count(*) AS count FROM users'),
  user: db.prepare('SELECT * FROM users WHERE username=?'),
  session: db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?'),
  setting: db.prepare('SELECT value FROM settings WHERE key=?'),
  plugin: db.prepare('SELECT * FROM plugins WHERE id=?'),
  plugins: db.prepare('SELECT * FROM plugins ORDER BY updated_at DESC'),
  enabled: db.prepare('SELECT * FROM plugins WHERE enabled=1 ORDER BY id'),
  forwardRules: db.prepare('SELECT * FROM forward_rules ORDER BY id DESC'),
  enabledRules: db.prepare('SELECT * FROM forward_rules WHERE enabled=1 ORDER BY id'),
  logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 100')
};
const now = () => new Date().toISOString();
const getSetting = (key, fallback = '') => q.setting.get(key)?.value ?? fallback;
const putSetting = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const insertLog = db.prepare('INSERT INTO logs(time,level,area,message) VALUES(?,?,?,?)');
const deliveredQq = db.prepare('SELECT 1 FROM qq_deliveries WHERE message_id=? AND action_index=?');
const markQqDelivered = db.prepare('INSERT OR IGNORE INTO qq_deliveries(message_id,action_index,delivered_at) VALUES(?,?,?)');
const aiTurn = db.prepare('SELECT assistant_text FROM ai_turns WHERE delivery_key=?');
const aiHistory = db.prepare('SELECT user_text,assistant_text FROM ai_turns WHERE conversation_key=? ORDER BY created_at DESC LIMIT 6');
const saveAiTurn = db.prepare('INSERT OR IGNORE INTO ai_turns(delivery_key,conversation_key,user_text,assistant_text,created_at) VALUES(?,?,?,?,?)');
const pruneAiTurns = db.prepare('DELETE FROM ai_turns WHERE created_at < ? OR delivery_key NOT IN (SELECT delivery_key FROM ai_turns ORDER BY created_at DESC LIMIT 5000)');
const aiProposals = db.prepare("SELECT * FROM ai_config_proposals WHERE status='pending' ORDER BY id DESC LIMIT 20");
const pendingAiProposal = db.prepare("SELECT id FROM ai_config_proposals WHERE status='pending' AND channel=? AND chat_id=? AND user_id=? AND setting_key=?");
const insertAiProposal = db.prepare('INSERT INTO ai_config_proposals(channel,chat_id,user_id,setting_key,value,label,created_at) VALUES(?,?,?,?,?,?,?)');
const updateAiProposal = db.prepare('UPDATE ai_config_proposals SET value=?,label=?,created_at=? WHERE id=?');
const getAiProposal = db.prepare('SELECT * FROM ai_config_proposals WHERE id=?');
const settleAiProposal = db.prepare("UPDATE ai_config_proposals SET status=? WHERE id=? AND status='pending'");
const qqInFlight = new Set();
const qqStatus = { lastEventAt: null, lastError: null };
function log(level, area, message) {
  insertLog.run(now(), level, area, String(message).slice(0, 1000));
  db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 1000)').run();
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function fail(res, status, message) { json(res, status, { error: message }); }
async function body(req) {
  const text = await rawBody(req);
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
async function rawBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return text;
}
function authorized(req) {
  const token = /(?:^|;\s*)ownman_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  return token && q.session.get(crypto.createHash('sha256').update(token).digest('hex'), Date.now());
}
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function validToken(provided) {
  const expected = getSetting('webhookToken');
  if (!expected || typeof provided !== 'string') return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(provided).digest(), crypto.createHash('sha256').update(expected).digest());
}
function session(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + 7 * 24 * 3600 * 1000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), userId, expires);
  json(res, 200, { ok: true }, { 'Set-Cookie': `ownman_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` });
}
function listPlugins() { return q.plugins.all().map(({ id, name, description, source, enabled, created_at, updated_at }) => ({ id, name, description, source, enabled: !!enabled, created_at, updated_at })); }
function validPlugin(input) {
  const name = String(input.name || '').trim();
  const source = String(input.source || '');
  if (!name || name.length > 80 || source.length > 50000) throw Object.assign(new Error('Provide a name and plugin source under 50 KB'), { status: 400 });
  return { name, description: String(input.description || '').slice(0, 300), source };
}
function processEvent(event, onlyId = null) {
  const actions = [];
  const errors = [];
  const plugins = onlyId ? [q.plugin.get(onlyId)].filter(Boolean) : q.enabled.all();
  for (const plugin of plugins) {
    try { actions.push(...runPlugin(plugin.source, event).map(action => ({ ...action, plugin: plugin.name }))); }
    catch (error) { log('error', 'plugin', `${plugin.name}: ${error.message}`); errors.push({ plugin: plugin.name, message: error.message }); }
  }
  if (!onlyId) {
    for (const rule of q.enabledRules.all()) {
      if (rule.source_channel !== event.channel || rule.source_chat_id !== event.chatId) continue;
      if (rule.mode === 'links' && !/https?:\/\/\S+/i.test(event.text)) continue;
      actions.push({ type: 'forward', channel: rule.target_channel, target: rule.target, text: event.text, plugin: `Rule #${rule.id}` });
    }
  }
  return { actions, errors };
}
function validRule(input) {
  const channels = ['qq', 'qqbot', 'weixin', 'wecom'];
  const sourceChannel = String(input.sourceChannel || '');
  const targetChannel = String(input.targetChannel || '');
  const sourceChatId = String(input.sourceChatId || '').trim();
  const target = String(input.target || '').trim();
  if (!channels.includes(sourceChannel) || !channels.includes(targetChannel) || !sourceChatId || sourceChatId.length > 120 || !target || target.length > 120) throw Object.assign(new Error('Valid source and target required'), { status: 400 });
  if (targetChannel === 'qq' && input.enabled !== false && !/^(group|private):\d+$/.test(target)) throw Object.assign(new Error('QQ target must be group:ID or private:ID'), { status: 400 });
  if (targetChannel === 'qqbot' && input.enabled !== false && !/^(group|private):[^\s:]{1,120}$/.test(target)) throw Object.assign(new Error('QQ Bot target must be group:OpenID or private:OpenID'), { status: 400 });
  if (targetChannel === 'wecom' && input.enabled !== false && !/^user:[a-zA-Z0-9._@-]{1,120}$/.test(target)) throw Object.assign(new Error('WeCom target must be user:UserID'), { status: 400 });
  return { sourceChannel, sourceChatId, targetChannel, target, mode: input.mode === 'links' ? 'links' : 'all', enabled: input.enabled !== false };
}
function listRules() {
  return q.forwardRules.all().map(rule => ({ id: rule.id, sourceChannel: rule.source_channel, sourceChatId: rule.source_chat_id, targetChannel: rule.target_channel, target: rule.target, mode: rule.mode, enabled: !!rule.enabled }));
}
function qqConfig() {
  try { return JSON.parse(getSetting('qq.config', '{}')); }
  catch { return {}; }
}
function publicQqConfig() {
  const config = qqConfig();
  return { enabled: !!config.enabled, endpoint: config.endpoint || '', accessToken: config.accessToken ? '********' : '', ...qqStatus };
}
function qqBotConfig() {
  try { return JSON.parse(getSetting('qqbot.config', '{}')); }
  catch { return {}; }
}
function publicQqBotConfig() {
  const config = qqBotConfig();
  return { enabled: !!config.enabled, appId: config.appId || '', appSecret: config.appSecret || '', ...qqBotBridge.status };
}
const wecomStatus = { lastEventAt: null, lastError: null };
function wecomConfig() {
  try { return JSON.parse(getSetting('wecom.config', '{}')); }
  catch { return {}; }
}
function publicWecomConfig() {
  const config = wecomConfig();
  return { enabled: !!config.enabled, corpId: config.corpId || '', agentId: config.agentId || '', secret: config.secret ? '********' : '', token: config.token ? '********' : '', encodingAesKey: config.encodingAesKey ? '********' : '', ...wecomStatus };
}
const wecomBridge = createWecomBridge({ getConfig: wecomConfig });
function getAiConfig() {
  try { return aiConfig(JSON.parse(getSetting('ai.config', '{}'))); }
  catch { return aiConfig(); }
}
function publicAiConfig() {
  const config = getAiConfig();
  return { ...config, apiKey: config.apiKey ? '********' : '', historyCount: db.prepare('SELECT count(*) AS count FROM ai_turns').get().count };
}
async function processIncoming(event) {
  const result = await applyRebates(event, processEvent(event), rebateAutomation(), convert, platformFor, log);
  const config = getAiConfig();
  const prompt = shouldAnswer(event, result, config);
  if (!prompt) return result;
  const proposal = parseAiConfigRequest(prompt);
  if (proposal) {
    try {
      const value = ['webSearch', 'enabled'].includes(proposal.key) ? proposal.value === 'true' : proposal.value;
      normalizeAiConfig({ ...config, [proposal.key]: value }, config);
      const existing = pendingAiProposal.get(event.channel, event.chatId, event.userId, proposal.key);
      if (existing) updateAiProposal.run(proposal.value, proposal.label, now(), existing.id);
      else if (aiProposals.all().length < 20) insertAiProposal.run(event.channel, event.chatId, event.userId, proposal.key, proposal.value, proposal.label, now());
      else throw new Error('待审核的配置请求已满，请管理员先处理');
      result.actions.push({ type: 'reply', text: `已提交“${proposal.label}”申请。管理员需在 AI 大脑页面确认，确认前配置不会改变。`, plugin: 'AI' });
    } catch (error) {
      result.actions.push({ type: 'reply', text: `无法提交配置申请：${error.message}`, plugin: 'AI' });
    }
    return result;
  }
  try {
    const key = event.deliveryKey || `test:${crypto.randomUUID()}`;
    const conversation = conversationKey(event);
    const answer = aiTurn.get(key)?.assistant_text || await generateAiReply(config, aiHistory.all(conversation).reverse(), prompt, fetch, new Date(), event.images || []);
    const action = { type: 'reply', text: answer, plugin: 'AI' };
    Object.defineProperty(action, 'aiTurn', { value: { key, conversation, prompt, answer } });
    result.actions.push(action);
  } catch (error) {
    log('error', 'ai', error.message);
    result.errors.push({ plugin: 'AI', message: error.message });
  }
  return result;
}
async function deliverActions(event, result) {
  const errors = [];
  const warnings = [];
  let delivered = 0;
  for (const [index, action] of result.actions.entries()) {
    const qqTarget = (event.channel === 'qq' && action.type === 'reply') || (action.type === 'forward' && action.channel === 'qq') ? qqDestination(action, event) : null;
    const botTarget = (event.channel === 'qqbot' && action.type === 'reply') || (action.type === 'forward' && action.channel === 'qqbot') ? qqBotDestination(action, event) : null;
    const wecomTarget = (event.channel === 'wecom' && action.type === 'reply') || (action.type === 'forward' && action.channel === 'wecom') ? wecomDestination(action, event) : null;
    if (!qqTarget && !botTarget && !wecomTarget) {
      warnings.push(`Action ${index + 1}: unsupported destination`);
      log('warn', event.channel, `Message ${event.messageId}, action ${index + 1}: unsupported destination`);
      continue;
    }
    if (deliveredQq.get(event.deliveryKey, index)) continue;
    try {
      if (qqTarget) await sendQq(qqConfig(), qqTarget, action.text, action.images || []);
      else if (botTarget) await qqBotBridge.send(botTarget, action.text, event.channel === 'qqbot' && botTarget.type === event.messageType && botTarget.id === event.chatId ? event.messageId : '', index + 1);
      else await wecomBridge.send(wecomTarget, action.text);
      if (!qqTarget && action.images?.length) {
        warnings.push(`Action ${index + 1}: image omitted; destination supports text only`);
        log('warn', event.channel, `Message ${event.messageId}, action ${index + 1}: image omitted; destination supports text only`);
      }
      markQqDelivered.run(event.deliveryKey, index, now());
      if (action.aiTurn) {
        saveAiTurn.run(action.aiTurn.key, action.aiTurn.conversation, action.aiTurn.prompt, action.aiTurn.answer, now());
        pruneAiTurns.run(new Date(Date.now() - 30 * 86400 * 1000).toISOString());
      }
      delivered++;
    } catch (error) {
      errors.push(`Action ${index + 1}: ${error.message}`);
      log('error', event.channel, `Message ${event.messageId}, action ${index + 1}: ${error.message}`);
    }
  }
  if (errors.length && event.channel === 'qq') qqStatus.lastError = errors.join('; ');
  if (errors.length && event.channel === 'wecom') wecomStatus.lastError = errors.join('; ');
  return { delivered, errors, warnings };
}
const platforms = {
  jd: ['jd.com', '3.cn'],
  taobao: ['taobao.com', 'tmall.com', 'tb.cn'],
  pdd: ['pinduoduo.com', 'yangkeduo.com']
};
function platformFor(url) {
  let host;
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) return null; host = parsed.hostname.toLowerCase(); }
  catch { return null; }
  return Object.entries(platforms).find(([, hosts]) => hosts.some(domain => host === domain || host.endsWith(`.${domain}`)))?.[0] || null;
}
function rebateConfig(platform) {
  try { return JSON.parse(getSetting(`rebate.${platform}`, '{}')); }
  catch { return {}; }
}
function rebateAutomation() {
  try {
    const value = JSON.parse(getSetting('rebate.automation', '{}'));
    return { enabled: !!value.enabled, reply: value.reply !== false, image: value.image === true, template: value.template || defaultRebateTemplate };
  } catch { return { enabled: false, reply: true, image: false, template: defaultRebateTemplate }; }
}
async function convert(input) {
  const url = String(input.url || '').trim();
  const platform = platformFor(url);
  if (!platform) throw Object.assign(new Error('Use a JD, Taobao or Pinduoduo product URL'), { status: 400 });
  const config = rebateConfig(platform);
  if (config.mode !== 'live' || config.provider !== 'official') {
    throw Object.assign(new Error('Configure the official affiliate connector first'), { status: 400 });
  }
  try {
    const details = await convertOfficial(platform, url, config);
    const result = { platform, mode: 'live', provider: 'official', sourceUrl: url, ...details };
    return { ...result, formattedText: formatRebate(result, rebateAutomation().template) };
  } catch (error) {
    let message = String(error.message || 'Official affiliate API failed');
    for (const secret of [config.appSecret, config.clientSecret, config.appKey, config.clientId]) {
      if (secret) message = message.replaceAll(secret, '[redacted]');
    }
    throw Object.assign(new Error(message.slice(0, 250)), { status: error.status || 502 });
  }
}
const qqBotBridge = createQqBotBridge({
  getConfig: qqBotConfig,
  onEvent: async event => {
    if (qqInFlight.has(event.deliveryKey)) return;
    qqInFlight.add(event.deliveryKey);
    try {
      log('info', 'qqbot', `${event.messageType} message ${event.messageId} from ${event.chatId}`);
      const result = await processIncoming(event);
      await deliverActions(event, result);
    } finally { qqInFlight.delete(event.deliveryKey); }
  },
  onError: error => log('error', 'qqbot', error.message)
});
const staticTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(req, res, pathname) {
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.resolve(root, 'public', filename);
  if (!full.startsWith(path.resolve(root, 'public') + path.sep) && full !== path.resolve(root, 'public', 'index.html')) return fail(res, 404, 'Not found');
  try { if (!fs.statSync(full).isFile()) return fail(res, 404, 'Not found'); res.writeHead(200, { 'Content-Type': staticTypes[path.extname(full)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); fs.createReadStream(full).pipe(res); }
  catch { fail(res, 404, 'Not found'); }
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (req.method === 'GET' && pathname === '/api/bootstrap') return json(res, 200, { setup: q.users.get().count === 0, authenticated: !!authorized(req), name: getSetting('name', 'xiaomizhou'), version });
    if (req.method === 'POST' && pathname === '/api/setup') {
      if (q.users.get().count) return fail(res, 409, 'Already initialized');
      const input = await body(req);
      if (String(input.password || '').length < 12 || !String(input.username || '').trim()) return fail(res, 400, 'Username and password of at least 12 characters required');
      const salt = crypto.randomBytes(16).toString('hex');
      const result = db.prepare('INSERT INTO users(username,salt,hash) VALUES(?,?,?)').run(String(input.username).trim(), salt, passwordHash(String(input.password), salt));
      putSetting.run('webhookToken', crypto.randomBytes(24).toString('hex'));
      log('info', 'system', 'Administrator account created');
      return session(res, Number(result.lastInsertRowid));
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      const input = await body(req); const user = q.user.get(String(input.username || ''));
      if (!user || !crypto.timingSafeEqual(Buffer.from(user.hash, 'hex'), Buffer.from(passwordHash(String(input.password || ''), user.salt), 'hex'))) return fail(res, 401, 'Invalid credentials');
      return session(res, user.id);
    }
    if (req.method === 'POST' && pathname === '/api/events') {
      if (!validToken(req.headers['x-webhook-token'])) return fail(res, 401, 'Invalid webhook token');
      const input = await body(req);
      const event = { channel: String(input.channel || ''), chatId: String(input.chatId || ''), userId: String(input.userId || ''), text: String(input.text || '').slice(0, 4000), images: Array.isArray(input.images) ? input.images.map(image => ({ url: imageUrl(image?.url) })).filter(image => image.url).slice(0, 3) : [] };
      log('info', 'event', `${event.channel}: ${event.chatId}`);
      return json(res, 200, await processIncoming(event));
    }
    if (req.method === 'POST' && pathname === '/api/qq/events') {
      if (!validToken(req.headers['x-webhook-token'] || new URL(req.url, 'http://localhost').searchParams.get('token'))) return fail(res, 401, 'Invalid webhook token');
      const config = qqConfig();
      if (!config.enabled) return fail(res, 409, 'QQ bridge is disabled');
      const event = oneBotEvent(await body(req));
      if (!event) return json(res, 200, { ignored: true });
      if (qqInFlight.has(event.deliveryKey)) return json(res, 200, { duplicate: true, inFlight: true });
      qqInFlight.add(event.deliveryKey);
      try {
        qqStatus.lastEventAt = now();
        log('info', 'qq', `${event.messageType} message ${event.messageId} from ${event.chatId}`);
        const result = await processIncoming(event);
        const delivery = await deliverActions(event, result);
        if (!delivery.errors.length) qqStatus.lastError = null;
        return json(res, delivery.errors.length ? 502 : 200, { ...result, ...delivery });
      } finally { qqInFlight.delete(event.deliveryKey); }
    }
    if (pathname === '/api/wecom/callback' && ['GET', 'POST'].includes(req.method)) {
      const config = wecomConfig();
      if (!config.enabled) return fail(res, 409, 'WeCom bridge is disabled');
      const query = new URL(req.url, 'http://localhost').searchParams;
      const clear = wecomCallback(req.method === 'GET' ? null : await rawBody(req), config, query);
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(clear);
      }
      const event = wecomEvent(clear, config);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('success');
      if (event && !qqInFlight.has(event.deliveryKey)) {
        qqInFlight.add(event.deliveryKey);
        wecomStatus.lastEventAt = now();
        log('info', 'wecom', `Message ${event.messageId} from ${event.userId}`);
        void (async () => {
          try {
            const result = await processIncoming(event);
            const delivery = await deliverActions(event, result);
            if (!delivery.errors.length) wecomStatus.lastError = null;
          } catch (error) { wecomStatus.lastError = error.message; log('error', 'wecom', error.message); }
          finally { qqInFlight.delete(event.deliveryKey); }
        })();
      }
      return;
    }
    if (!authorized(req)) return fail(res, 401, 'Sign in required');
    if (req.method === 'POST' && pathname === '/api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': 'ownman_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    if (req.method === 'GET' && pathname === '/api/updates') return json(res, 200, { currentVersion: version, managed: typeof process.send === 'function' && process.env.XIAOMIZHOU_MANAGED === '1', installing: installingUpdate });
    if (req.method === 'POST' && pathname === '/api/updates/check') return json(res, 200, await checkUpdate(version));
    if (req.method === 'POST' && pathname === '/api/updates/install') {
      if (typeof process.send !== 'function' || process.env.XIAOMIZHOU_MANAGED !== '1') return fail(res, 409, 'Online installation requires the Docker launcher; rebuild and restart the container first');
      if (installingUpdate) return fail(res, 409, 'An update is already being installed');
      const input = await body(req);
      installingUpdate = true;
      try {
        const info = await installUpdate({ currentVersion: version, expectedVersion: String(input.version || ''), root, dataDir, backup: target => backup(db, target) });
        log('info', 'update', `Installed v${info.latestVersion}; restarting`);
        json(res, 200, { ok: true, version: info.latestVersion });
        setTimeout(() => { process.send?.({ type: 'update-installed' }); setTimeout(() => process.exit(0), 200); }, 200);
        return;
      } finally { installingUpdate = false; }
    }
    if (req.method === 'GET' && pathname === '/api/backup') {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ownman-backup-'));
      const file = path.join(temporary, 'ownman.db');
      try {
        await backup(db, file);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.sqlite3',
          'Content-Disposition': `attachment; filename="xiaomizhou-${new Date().toISOString().slice(0, 10)}.db"`,
          'Content-Length': fs.statSync(file).size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        const stream = fs.createReadStream(file);
        stream.on('error', error => { log('error', 'backup', error.message); res.destroy(error); });
        stream.on('close', () => {
          try { fs.rmSync(temporary, { recursive: true, force: true }); }
          catch (error) { log('error', 'backup', `Temporary cleanup: ${error.message}`); }
        });
        res.on('close', () => stream.destroy());
        log('info', 'backup', 'Database snapshot downloaded');
        return stream.pipe(res);
      } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    if (req.method === 'GET' && pathname === '/api/overview') return json(res, 200, { pluginCount: q.plugins.all().length, enabledCount: q.enabled.all().length, recentLogs: q.logs.all().slice(0, 8), providers: Object.fromEntries(Object.keys(platforms).map(p => { const config = rebateConfig(p); return [p, config.mode === 'live' && config.provider === 'official' ? 'live' : 'unconfigured']; })), qq: publicQqConfig(), qqbot: publicQqBotConfig(), wecom: publicWecomConfig(), ai: { enabled: getAiConfig().enabled, provider: getAiConfig().provider, model: getAiConfig().model } });
    if (req.method === 'GET' && pathname === '/api/settings') return json(res, 200, { name: getSetting('name', 'xiaomizhou'), webhookToken: getSetting('webhookToken') });
    if (req.method === 'PUT' && pathname === '/api/settings') { const input = await body(req); putSetting.run('name', String(input.name || 'xiaomizhou').slice(0, 60)); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && pathname === '/api/ai') return json(res, 200, publicAiConfig());
    if (req.method === 'GET' && pathname === '/api/ai/proposals') return json(res, 200, { proposals: aiProposals.all().map(({ id, channel, chat_id, user_id, setting_key, value, label, created_at }) => ({ id, channel, chatId: chat_id, userId: user_id, key: setting_key, value, label, createdAt: created_at })) });
    const proposalMatch = /^\/api\/ai\/proposals\/(\d+)\/(approve|reject)$/.exec(pathname);
    if (req.method === 'POST' && proposalMatch) {
      const proposal = getAiProposal.get(Number(proposalMatch[1]));
      if (!proposal || proposal.status !== 'pending') return fail(res, 404, 'Pending proposal not found');
      if (proposalMatch[2] === 'approve') {
        if (!['webSearch', 'timeZone', 'model', 'enabled'].includes(proposal.setting_key)) return fail(res, 400, 'Unsupported AI setting');
        const current = getAiConfig();
        const value = ['webSearch', 'enabled'].includes(proposal.setting_key) ? proposal.value === 'true' : proposal.value;
        const config = normalizeAiConfig({ ...current, [proposal.setting_key]: value }, current);
        putSetting.run('ai.config', JSON.stringify(config));
      }
      settleAiProposal.run(proposalMatch[2] === 'approve' ? 'approved' : 'rejected', proposal.id);
      db.prepare("DELETE FROM ai_config_proposals WHERE status!='pending' AND id NOT IN (SELECT id FROM ai_config_proposals ORDER BY id DESC LIMIT 200)").run();
      log('info', 'ai', `Configuration proposal #${proposal.id} ${proposalMatch[2] === 'approve' ? 'approved' : 'rejected'}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && pathname === '/api/ai') {
      const config = normalizeAiConfig(await body(req), getAiConfig());
      putSetting.run('ai.config', JSON.stringify(config));
      log('info', 'ai', `${config.provider} ${config.enabled ? 'enabled' : 'disabled'}`);
      return json(res, 200, publicAiConfig());
    }
    if (req.method === 'POST' && pathname === '/api/ai/test') {
      const input = await body(req);
      const text = String(input.text || '').trim();
      if (!text || text.length > 4000) return fail(res, 400, 'Provide test text under 4000 characters');
      const config = getAiConfig();
      if (!config.apiKey) return fail(res, 400, 'Configure an AI API key first');
      return json(res, 200, { reply: await generateAiReply(config, [], text) });
    }
    if (req.method === 'DELETE' && pathname === '/api/ai/history') {
      db.prepare('DELETE FROM ai_turns').run();
      log('info', 'ai', 'Conversation history cleared');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/qq') return json(res, 200, publicQqConfig());
    if (req.method === 'PUT' && pathname === '/api/qq') {
      const input = await body(req);
      const old = qqConfig();
      const endpoint = String(input.endpoint || '').trim();
      let parsed;
      try { parsed = new URL(endpoint); } catch { return fail(res, 400, 'Valid OneBot HTTP API URL required'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return fail(res, 400, 'Use an HTTP API base URL without credentials or query');
      const config = { enabled: !!input.enabled, endpoint: parsed.href.replace(/\/$/, ''), accessToken: input.accessToken === '********' ? old.accessToken || '' : String(input.accessToken || '') };
      putSetting.run('qq.config', JSON.stringify(config));
      qqStatus.lastError = null;
      log('info', 'qq', `QQ bridge ${config.enabled ? 'enabled' : 'disabled'}`);
      return json(res, 200, publicQqConfig());
    }
    if (req.method === 'POST' && pathname === '/api/qq/test') {
      const config = qqConfig();
      if (!config.endpoint) return fail(res, 400, 'Configure QQ API first');
      const account = await oneBotCall(config, 'get_login_info', {});
      return json(res, 200, { userId: String(account?.user_id || ''), nickname: String(account?.nickname || '') });
    }
    if (req.method === 'GET' && pathname === '/api/qqbot') return json(res, 200, publicQqBotConfig());
    if (req.method === 'PUT' && pathname === '/api/qqbot') {
      const input = await body(req);
      const old = qqBotConfig();
      const config = { enabled: input.enabled === true, appId: String(input.appId || '').trim(), appSecret: input.appSecret === '********' ? old.appSecret || '' : String(input.appSecret || '') };
      if (config.enabled && (!/^\d+$/.test(config.appId) || !config.appSecret)) return fail(res, 400, 'AppID and AppSecret required');
      putSetting.run('qqbot.config', JSON.stringify(config));
      qqBotBridge.start();
      log('info', 'qqbot', `QQ Bot ${config.enabled ? 'enabled' : 'disabled'}`);
      return json(res, 200, publicQqBotConfig());
    }
    if (req.method === 'POST' && pathname === '/api/qqbot/test') {
      if (!qqBotConfig().appId || !qqBotConfig().appSecret) return fail(res, 400, 'Configure AppID and AppSecret first');
      const gateway = await qqBotBridge.gateway();
      return json(res, 200, { gatewayHost: new URL(gateway).hostname });
    }
    if (req.method === 'GET' && pathname === '/api/wecom') return json(res, 200, publicWecomConfig());
    if (req.method === 'PUT' && pathname === '/api/wecom') {
      const input = await body(req);
      const old = wecomConfig();
      const secret = key => input[key] === '********' ? old[key] || '' : String(input[key] || '').trim();
      const config = { enabled: input.enabled === true, corpId: String(input.corpId || '').trim(), agentId: String(input.agentId || '').trim(), secret: secret('secret'), token: secret('token'), encodingAesKey: secret('encodingAesKey') };
      if (config.enabled && (!/^ww[a-zA-Z0-9]+$/.test(config.corpId) || !/^\d+$/.test(config.agentId) || !config.secret || !config.token || !/^[A-Za-z0-9+/]{43}$/.test(config.encodingAesKey))) return fail(res, 400, 'Valid CorpID, AgentID, Secret, Token and EncodingAESKey required');
      putSetting.run('wecom.config', JSON.stringify(config));
      wecomBridge.reset();
      wecomStatus.lastError = null;
      log('info', 'wecom', `WeCom app ${config.enabled ? 'enabled' : 'disabled'}`);
      return json(res, 200, publicWecomConfig());
    }
    if (req.method === 'POST' && pathname === '/api/wecom/test') {
      const config = wecomConfig();
      if (!config.enabled) return fail(res, 409, 'Enable WeCom app first');
      await wecomBridge.token();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/logs') return json(res, 200, { logs: q.logs.all() });
    if (req.method === 'GET' && pathname === '/api/plugins') return json(res, 200, { plugins: listPlugins() });
    if (req.method === 'GET' && pathname === '/api/forwards') return json(res, 200, { rules: listRules() });
    if (req.method === 'POST' && pathname === '/api/forwards') {
      const rule = validRule(await body(req));
      const result = db.prepare('INSERT INTO forward_rules(source_channel,source_chat_id,target_channel,target,mode,enabled) VALUES(?,?,?,?,?,?)').run(rule.sourceChannel, rule.sourceChatId, rule.targetChannel, rule.target, rule.mode, rule.enabled ? 1 : 0);
      log('info', 'forward', `Created rule ${result.lastInsertRowid}`);
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    }
    const ruleMatch = /^\/api\/forwards\/(\d+)$/.exec(pathname);
    if (ruleMatch) {
      const id = Number(ruleMatch[1]);
      if (!db.prepare('SELECT 1 FROM forward_rules WHERE id=?').get(id)) return fail(res, 404, 'Rule not found');
      if (req.method === 'PUT') {
        const rule = validRule(await body(req));
        db.prepare('UPDATE forward_rules SET source_channel=?,source_chat_id=?,target_channel=?,target=?,mode=?,enabled=? WHERE id=?').run(rule.sourceChannel, rule.sourceChatId, rule.targetChannel, rule.target, rule.mode, rule.enabled ? 1 : 0, id);
        log('info', 'forward', `Updated rule ${id}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') { db.prepare('DELETE FROM forward_rules WHERE id=?').run(id); log('info', 'forward', `Deleted rule ${id}`); return json(res, 200, { ok: true }); }
    }
    if (req.method === 'POST' && pathname === '/api/plugins') {
      const plugin = validPlugin(await body(req)); const time = now();
      const result = db.prepare('INSERT INTO plugins(name,description,source,created_at,updated_at) VALUES(?,?,?,?,?)').run(plugin.name, plugin.description, plugin.source, time, time);
      log('info', 'plugin', `Created ${plugin.name}`); return json(res, 201, { id: Number(result.lastInsertRowid) });
    }
    const pluginMatch = /^\/api\/plugins\/(\d+)(?:\/(test|toggle))?$/.exec(pathname);
    if (pluginMatch) {
      const id = Number(pluginMatch[1]); const plugin = q.plugin.get(id); if (!plugin) return fail(res, 404, 'Plugin not found');
      if (req.method === 'PUT' && !pluginMatch[2]) { const input = validPlugin(await body(req)); db.prepare('UPDATE plugins SET name=?,description=?,source=?,updated_at=? WHERE id=?').run(input.name, input.description, input.source, now(), id); log('info', 'plugin', `Updated ${input.name}`); return json(res, 200, { ok: true }); }
      if (req.method === 'DELETE' && !pluginMatch[2]) { db.prepare('DELETE FROM plugins WHERE id=?').run(id); log('info', 'plugin', `Deleted ${plugin.name}`); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && pluginMatch[2] === 'toggle') { db.prepare('UPDATE plugins SET enabled=?,updated_at=? WHERE id=?').run(plugin.enabled ? 0 : 1, now(), id); log('info', 'plugin', `${plugin.enabled ? 'Disabled' : 'Enabled'} ${plugin.name}`); return json(res, 200, { enabled: !plugin.enabled }); }
      if (req.method === 'POST' && pluginMatch[2] === 'test') { const input = await body(req); return json(res, 200, processEvent({ channel: String(input.channel || 'qq'), chatId: String(input.chatId || 'test'), userId: String(input.userId || 'tester'), text: String(input.text || '') }, id)); }
    }
    if (req.method === 'GET' && pathname === '/api/rebates') return json(res, 200, { providers: Object.fromEntries(Object.keys(platforms).map(p => {
      const config = rebateConfig(p);
      return [p, { appKey: config.appKey || '', appSecret: config.appSecret || '', jdMethod: config.jdMethod || 'social', siteId: config.siteId || '', positionId: config.positionId || '', adzoneId: config.adzoneId || '', clientId: config.clientId || '', clientSecret: config.clientSecret || '', pid: config.pid || '', configured: config.mode === 'live' && config.provider === 'official' }];
    })) });
    if (req.method === 'GET' && pathname === '/api/rebates/automation') return json(res, 200, rebateAutomation());
    if (req.method === 'PUT' && pathname === '/api/rebates/automation') {
      const input = await body(req);
      const template = validateRebateTemplate(input.template ?? rebateAutomation().template);
      putSetting.run('rebate.automation', JSON.stringify({ enabled: input.enabled === true, reply: input.reply !== false, image: input.image === true, template }));
      log('info', 'rebate', `Automatic conversion ${input.enabled === true ? 'enabled' : 'disabled'}`);
      return json(res, 200, rebateAutomation());
    }
    if (req.method === 'PUT' && pathname === '/api/rebates') {
      const input = await body(req); if (!platforms[input.platform]) return fail(res, 400, 'Unknown platform');
      if ((input.mode && input.mode !== 'live') || (input.provider && input.provider !== 'official')) return fail(res, 400, 'Only official affiliate connectors are supported');
      const old = rebateConfig(input.platform);
      const config = {
        mode: 'live', provider: 'official',
        appKey: String(input.appKey || '').trim(), appSecret: input.appSecret === '********' ? old.appSecret || '' : String(input.appSecret || ''),
        jdMethod: input.jdMethod === 'site' ? 'site' : 'social', siteId: String(input.siteId || '').trim(),
        positionId: String(input.positionId || '').trim(), adzoneId: String(input.adzoneId || '').trim(),
        clientId: String(input.clientId || '').trim(), clientSecret: input.clientSecret === '********' ? old.clientSecret || '' : String(input.clientSecret || ''), pid: String(input.pid || '').trim()
      };
      if (input.platform === 'pdd') {
        if (!config.clientId || !config.clientSecret || !config.pid) return fail(res, 400, 'Client ID, Client Secret and PID are required');
      } else {
        if (!config.appKey || !config.appSecret) return fail(res, 400, 'AppKey and AppSecret are required');
        const id = input.platform === 'jd' ? config.siteId : config.adzoneId;
        if ((input.platform !== 'jd' || config.jdMethod === 'site') && !/^\d+$/.test(id)) return fail(res, 400, input.platform === 'jd' ? 'Numeric JD site ID required' : 'Numeric Taobao adzone ID required');
        if (input.platform === 'jd' && config.positionId && (!/^\d+$/.test(config.positionId) || !Number.isSafeInteger(Number(config.positionId)))) return fail(res, 400, 'Safe numeric JD position ID required');
      }
      putSetting.run(`rebate.${input.platform}`, JSON.stringify(config)); log('info', 'rebate', `Updated ${input.platform} connector`); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/rebates/convert') { const input = await body(req); const result = await convert(input); log('info', 'rebate', `${result.platform} ${result.mode} conversion`); return json(res, 200, result); }
    return fail(res, 404, 'Not found');
  } catch (error) { log('error', 'server', error.message); fail(res, error.status || 500, error.status ? error.message : 'Operation failed; check logs'); }
});
server.listen(port, '0.0.0.0', () => {
  console.log(`xiaomizhou listening on http://0.0.0.0:${port}`);
  qqBotBridge.start();
});
