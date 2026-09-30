import crypto from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const apiBase = 'https://qyapi.weixin.qq.com/cgi-bin';
const parser = new XMLParser({ ignoreAttributes: true, processEntities: false, parseTagValue: false, trimValues: false });

function xml(raw) {
  if (XMLValidator.validate(raw) !== true) throw new Error('Invalid WeCom XML');
  const value = parser.parse(raw)?.xml;
  if (!value || typeof value !== 'object') throw new Error('Invalid WeCom XML root');
  return value;
}

export function wecomSignature(token, timestamp, nonce, encrypted) {
  return crypto.createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
}

export function decryptWecom(config, encrypted, signature, timestamp, nonce) {
  const expected = wecomSignature(config.token, timestamp, nonce, encrypted);
  if (!/^[a-f\d]{40}$/i.test(signature) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()))) throw Object.assign(new Error('Invalid WeCom signature'), { status: 403 });
  const key = Buffer.from(`${config.encodingAesKey}=`, 'base64');
  if (key.length !== 32) throw new Error('Invalid WeCom EncodingAESKey');
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  } catch { throw Object.assign(new Error('Invalid WeCom ciphertext'), { status: 400 }); }
  if (plain.length < 20) throw Object.assign(new Error('Invalid WeCom message'), { status: 400 });
  const length = plain.readUInt32BE(16);
  if (length < 1 || 20 + length > plain.length) throw Object.assign(new Error('Invalid WeCom message length'), { status: 400 });
  const receiver = plain.subarray(20 + length).toString('utf8');
  if (receiver !== config.corpId) throw Object.assign(new Error('WeCom CorpID mismatch'), { status: 403 });
  return plain.subarray(20, 20 + length).toString('utf8');
}

export function wecomEvent(raw, config) {
  const message = xml(raw);
  if (message.MsgType !== 'text' || String(message.AgentID) !== String(config.agentId)) return null;
  const userId = String(message.FromUserName || '');
  const messageId = String(message.MsgId || '');
  const text = String(message.Content || '').trim().slice(0, 4000);
  if (!userId || !messageId || !text || String(message.ToUserName) !== config.corpId) return null;
  return { channel: 'wecom', chatId: userId, userId, text, messageId, messageType: 'private', deliveryKey: `wecom:${userId}:${messageId}` };
}

export function wecomDestination(action, event) {
  if (action.type === 'reply' && event.channel === 'wecom') return { userId: event.userId };
  if (action.type !== 'forward' || action.channel !== 'wecom') return null;
  const match = /^user:([a-zA-Z0-9._@-]{1,120})$/.exec(action.target);
  return match ? { userId: match[1] } : null;
}

export function createWecomBridge({ getConfig, fetchImpl = fetch }) {
  let accessToken = '';
  let expiresAt = 0;
  let pending = null;
  async function token() {
    const config = getConfig();
    if (!config.corpId || !config.secret) throw new Error('WeCom CorpID and Secret required');
    if (accessToken && Date.now() < expiresAt) return accessToken;
    if (!pending) pending = (async () => {
      const url = new URL(`${apiBase}/gettoken`);
      url.searchParams.set('corpid', config.corpId);
      url.searchParams.set('corpsecret', config.secret);
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new Error(`WeCom token HTTP ${response.status}`);
      const result = await response.json();
      if (result.errcode !== 0 || !result.access_token) throw new Error(`WeCom token error ${result.errcode}: ${result.errmsg || ''}`);
      accessToken = result.access_token;
      expiresAt = Date.now() + Math.max(0, Number(result.expires_in || 0) - 60) * 1000;
      return accessToken;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function send(destination, text) {
    const config = getConfig();
    if (!config.enabled) throw new Error('WeCom bridge is disabled');
    if (Buffer.byteLength(String(text), 'utf8') > 2048) throw new Error('WeCom text exceeds 2048 bytes');
    const url = new URL(`${apiBase}/message/send`);
    url.searchParams.set('access_token', await token());
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: destination.userId, msgtype: 'text', agentid: Number(config.agentId), text: { content: String(text) }, safe: 0 }),
      signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`WeCom send HTTP ${response.status}`);
    const result = await response.json();
    if (result.errcode !== 0 || result.invaliduser) throw new Error(`WeCom send error ${result.errcode}: ${result.errmsg || result.invaliduser || ''}`);
    return result;
  }
  function reset() { accessToken = ''; expiresAt = 0; pending = null; }
  return { token, send, reset };
}

export function wecomCallback(raw, config, query) {
  const signature = query.get('msg_signature') || '';
  const timestamp = query.get('timestamp') || '';
  const nonce = query.get('nonce') || '';
  if (!signature || !/^\d{1,15}$/.test(timestamp) || !nonce) throw Object.assign(new Error('Missing WeCom callback signature'), { status: 403 });
  const encrypted = raw === null ? query.get('echostr') : xml(raw).Encrypt;
  if (typeof encrypted !== 'string' || !encrypted) throw Object.assign(new Error('Missing WeCom ciphertext'), { status: 400 });
  return decryptWecom(config, encrypted, signature, timestamp, nonce);
}
