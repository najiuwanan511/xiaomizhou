const apiBase = 'https://api.sgroup.qq.com';
const tokenUrl = 'https://bots.qq.com/app/getAppAccessToken';

export function qqBotEvent(payload) {
  if (payload?.op !== 0 || !['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(payload.t)) return null;
  const data = payload.d || {};
  const group = payload.t === 'GROUP_AT_MESSAGE_CREATE';
  const userId = String(data.author?.member_openid || data.author?.user_openid || '');
  const chatId = String(group ? data.group_openid || '' : userId);
  const messageId = String(data.id || '');
  const text = String(data.content || '').trim().slice(0, 4000);
  if (!userId || !chatId || !messageId || !text) return null;
  return { channel: 'qqbot', chatId, userId, text, messageId, messageType: group ? 'group' : 'private', deliveryKey: `qqbot:${group ? 'group' : 'private'}:${chatId}:${messageId}` };
}

export function qqBotDestination(action, event) {
  if (action.type === 'reply' && event.channel === 'qqbot') return { type: event.messageType, id: event.chatId };
  if (action.type !== 'forward' || action.channel !== 'qqbot') return null;
  const match = /^(group|private):([^\s:]{1,120})$/.exec(action.target);
  return match ? { type: match[1], id: match[2] } : null;
}

export function createQqBotBridge({ getConfig, onEvent, onError, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
  let active = false;
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let sequence = null;
  let accessToken = '';
  let tokenExpiresAt = 0;
  let tokenRequest = null;
  const status = { connected: false, lastEventAt: null, lastError: null };

  function report(error) {
    status.lastError = error.message;
    onError(error);
  }
  async function token() {
    if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
    if (!tokenRequest) tokenRequest = (async () => {
      const config = getConfig();
      if (!config.appId || !config.appSecret) throw new Error('QQ Bot AppID and AppSecret required');
      const response = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }), signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new Error(`QQ Bot token HTTP ${response.status}`);
      const result = await response.json();
      if (!result.access_token) throw new Error('QQ Bot returned no access token');
      accessToken = result.access_token;
      tokenExpiresAt = Date.now() + Math.max(0, Number(result.expires_in || 0) - 60) * 1000;
      return accessToken;
    })().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }
  async function gateway() {
    const response = await fetchImpl(`${apiBase}/gateway`, { headers: { Authorization: `QQBot ${await token()}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error(`QQ Bot gateway HTTP ${response.status}`);
    const address = new URL((await response.json()).url);
    if (address.protocol !== 'wss:' || !(address.hostname === 'qq.com' || address.hostname.endsWith('.qq.com'))) throw new Error('Invalid QQ Bot gateway URL');
    return address.href;
  }
  function scheduleReconnect() {
    if (active && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  }
  async function connect() {
    if (!active) return;
    try {
      const address = await gateway();
      if (!active) return;
      const ws = new WebSocketImpl(address);
      socket = ws;
      ws.addEventListener('message', async ({ data }) => {
        try {
          const payload = JSON.parse(String(data));
          if (typeof payload.s === 'number') sequence = payload.s;
          if (payload.op === 10) {
            ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${await token()}`, intents: 1 << 25, shard: [0, 1], properties: { $os: 'linux', $browser: 'xiaomizhou', $device: 'xiaomizhou' } } }));
            const interval = Number(payload.d?.heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid QQ Bot heartbeat interval');
            heartbeatTimer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: sequence })); }, interval);
          } else if (payload.op === 0 && payload.t === 'READY') {
            status.connected = true;
            status.lastError = null;
          } else if (payload.op === 0) {
            const event = qqBotEvent(payload);
            if (event) { status.lastEventAt = new Date().toISOString(); await onEvent(event); }
          } else if (payload.op === 7 || payload.op === 9) {
            ws.close();
          }
        } catch (error) { report(error); }
      });
      ws.addEventListener('error', () => { report(new Error('QQ Bot WebSocket connection failed')); ws.close(); });
      ws.addEventListener('close', () => {
        if (socket !== ws) return;
        socket = null;
        status.connected = false;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        scheduleReconnect();
      });
    } catch (error) { report(error); scheduleReconnect(); }
  }
  function stop() {
    active = false;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
    socket?.close();
    socket = null;
    status.connected = false;
    accessToken = '';
    tokenExpiresAt = 0;
  }
  function start() { stop(); if (getConfig().enabled) { active = true; connect(); } }
  async function send(destination, text, messageId = '', sequenceNumber = 1) {
    const route = destination.type === 'group' ? `groups/${encodeURIComponent(destination.id)}` : `users/${encodeURIComponent(destination.id)}`;
    const response = await fetchImpl(`${apiBase}/v2/${route}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${await token()}` },
      body: JSON.stringify({ content: String(text).slice(0, 4000), msg_type: 0, msg_seq: sequenceNumber, ...(messageId ? { msg_id: messageId } : {}) }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`QQ Bot send HTTP ${response.status}`);
    const result = await response.json();
    if (result.code && result.code !== 0) throw new Error(`QQ Bot send code ${result.code}`);
    return result;
  }
  return { start, stop, token, gateway, send, status };
}
