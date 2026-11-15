import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { oneBotCall } from './qq-bridge.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const upstreamError = message => Object.assign(new Error(message), { status: 502 });

export function napcatBaseUrl(value, label) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw invalid(`${label}需要填写完整的 HTTP 地址`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw invalid(`${label}只填写协议、主机和端口，不带路径、令牌或查询参数`);
  }
  return url.origin;
}

export function parseNapcatConfig(input, old = {}) {
  const webuiUrl = input.webuiUrl ? napcatBaseUrl(input.webuiUrl, 'NapCat 管理地址') : '';
  const onebotUrl = input.onebotUrl ? napcatBaseUrl(input.onebotUrl, '消息 API 地址') : '';
  const callbackBaseUrl = input.callbackBaseUrl ? napcatBaseUrl(input.callbackBaseUrl, '小米粥访问地址') : '';
  const webuiToken = input.webuiToken === '********' ? old.webuiToken || '' : String(input.webuiToken || '');
  if (webuiToken.length > 1000) throw invalid('NapCat WebUI Token 过长');
  return { webuiUrl, webuiToken, onebotUrl, callbackBaseUrl };
}

// Match the retained NapCat WebUI API: SHA-256(token + '.napcat'), then Bearer Credential.
// Credentials and QR payloads live in server memory only and are never logged.
export function createNapcatManager({ getConfig, getQqConfig, fetcher = fetch }) {
  let session = null;
  let qrCache = null;
  let connecting = false;
  const clear = () => { session = null; qrCache = null; };

  async function request(config, action, payload = {}, credential = '') {
    let response;
    try {
      response = await fetcher(`${config.webuiUrl}/api/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(6000)
      });
    } catch { throw upstreamError('无法连接 NapCat，请检查服务是否启动及管理地址是否可访问'); }
    if (response.status === 401 || response.status === 403) throw Object.assign(upstreamError('NapCat 管理凭证已失效'), { auth: true });
    if (!response.ok) throw upstreamError(`NapCat 管理接口 HTTP ${response.status}，请检查地址和版本`);
    const result = await response.json().catch(() => null);
    if (!result || typeof result.code !== 'number') throw upstreamError('NapCat 管理接口响应不兼容，请检查地址和版本');
    if (result.code !== 0) {
      const auth = /unauthorized|authorization|credential|token.*(invalid|expired|revoked)/i.test(result.message || '');
      // Do not relay arbitrary upstream messages, which can contain credentials or URLs.
      throw Object.assign(upstreamError(auth ? 'NapCat WebUI Token 不正确或凭证失效' : `NapCat 操作失败（${action.split('/').at(-1)}），请查看 NapCat 日志`), { auth });
    }
    return result.data;
  }

  async function credential(config) {
    const key = crypto.createHash('sha256').update(`${config.webuiUrl}\0${config.webuiToken}`).digest('hex');
    if (session?.key === key && session.expires > Date.now()) return session.pending;
    const current = {
      key, expires: Date.now() + 50 * 60 * 1000,
      pending: request(config, 'auth/login', { hash: crypto.createHash('sha256').update(`${config.webuiToken}.napcat`).digest('hex') })
        .then(data => {
          if (typeof data?.Credential !== 'string' || !data.Credential) throw upstreamError('NapCat 未返回管理凭证，请检查版本');
          return data.Credential;
        })
    };
    session = current;
    try { return await current.pending; }
    catch (error) {
      if (session === current) {
        // Keep a rejected auth result briefly so polling a wrong token does not
        // consume NapCat's login-rate budget. Saving config clears it immediately.
        if (error.auth) current.expires = Date.now() + 60000;
        else session = null;
      }
      throw error;
    }
  }

  async function call(config, action, payload = {}) {
    if (!config.webuiUrl || !config.webuiToken) throw invalid('请先保存 NapCat 管理地址和 WebUI Token');
    const token = await credential(config);
    try { return await request(config, action, payload, token); }
    catch (error) {
      if (!error.auth) throw error;
      session = null;
      return request(config, action, payload, await credential(config));
    }
  }

  async function status() {
    const config = getConfig();
    const result = { configured: !!(config.webuiUrl && config.webuiToken), reachable: false, state: 'unconfigured', account: null, qrCode: null, messageConnected: false, checkedAt: new Date().toISOString(), error: null };
    if (!result.configured) return result;
    let login;
    try {
      login = await call(config, 'QQLogin/CheckLoginStatus');
      if (typeof login?.isLogin !== 'boolean') throw upstreamError('NapCat 登录状态响应不兼容');
      result.reachable = true;
      result.state = login.isLogin ? 'online' : login.isOffline ? 'offline' : 'waiting';
    } catch (error) {
      return { ...result, state: error.auth ? 'auth-error' : 'unreachable', error: error.message };
    }
    if (login.isLogin || login.isOffline) {
      try {
        const info = await call(config, 'QQLogin/GetQQLoginInfo');
        result.account = { userId: String(info?.uin || ''), nickname: String(info?.nick || '') };
      } catch (error) { result.error = error.message; }
      qrCache = null;
    } else if (typeof login.qrcodeurl === 'string' && login.qrcodeurl && login.qrcodeurl.length <= 2048) {
      // This is the QQ login URL to encode, not a remote image to fetch.
      if (qrCache?.value !== login.qrcodeurl) qrCache = { value: login.qrcodeurl, image: await QRCode.toDataURL(login.qrcodeurl, { width: 256, margin: 2, errorCorrectionLevel: 'M' }) };
      result.qrCode = qrCache.image;
    }
    if (login.loginError) result.error = 'QQ 登录尚未完成或二维码已过期，请刷新二维码；详细原因见 NapCat 日志';
    const qq = getQqConfig();
    if (login.isLogin && qq.enabled && qq.endpoint && result.account?.userId) {
      try {
        const account = await oneBotCall(qq, 'get_login_info', {});
        result.messageConnected = String(account?.user_id || '') === result.account.userId;
      } catch { /* The account is online; the message API can still need setup. */ }
    }
    return result;
  }

  async function refreshQr() {
    await call(getConfig(), 'QQLogin/RefreshQRcode');
    qrCache = null;
    return { ok: true };
  }

  async function connect(webhookToken, saveQqConfig) {
    if (connecting) throw Object.assign(new Error('正在接通消息，请稍候'), { status: 409 });
    connecting = true;
    try {
      const config = getConfig();
      if (!config.onebotUrl || !config.callbackBaseUrl) throw invalid('请先保存消息 API 地址和小米粥访问地址');
      const endpoint = new URL(config.onebotUrl);
      if (endpoint.protocol !== 'http:') throw invalid('自动接通需要 NapCat 直接提供的 HTTP 地址；HTTPS 反向代理请使用手动接入');
      const login = await call(config, 'QQLogin/CheckLoginStatus');
      if (!login?.isLogin) throw Object.assign(new Error('请先使用手机 QQ 扫码并确认登录'), { status: 409 });
      const current = await call(config, 'OB11Config/GetConfig');
      if (!current?.network || !Array.isArray(current.network.httpServers) || !Array.isArray(current.network.httpClients)) throw upstreamError('NapCat 网络配置格式不兼容，未修改配置');
      const updated = structuredClone(current);
      const port = Number(endpoint.port || 80);
      const servers = updated.network.httpServers;
      const clients = updated.network.httpClients;
      const namedServer = servers.findIndex(server => server.name === 'xiaomizhou-http');
      const portServer = servers.findIndex(server => Number(server.port) === port && server.enable);
      if (portServer !== -1 && portServer !== namedServer) throw Object.assign(new Error('消息 API 端口已被其他 NapCat HTTP 服务使用。请换一个空闲端口，或在手动接入中连接已有服务'), { status: 409 });
      const accessToken = (namedServer !== -1 && servers[namedServer].token) || crypto.randomBytes(24).toString('hex');
      const httpServer = { ...(servers[namedServer] || {}), name: 'xiaomizhou-http', enable: true, host: config.bundled ? '127.0.0.1' : '0.0.0.0', port, messagePostFormat: 'array', enableCors: false, enableWebsocket: false, token: accessToken, debug: false };
      if (namedServer === -1) servers.push(httpServer); else servers[namedServer] = httpServer;
      const callback = new URL('/api/qq/events', config.callbackBaseUrl);
      callback.searchParams.set('token', webhookToken);
      const clientIndex = clients.findIndex(client => client.name === 'xiaomizhou-events');
      const httpClient = { ...(clients[clientIndex] || {}), name: 'xiaomizhou-events', enable: true, url: callback.href, messagePostFormat: 'array', reportSelfMessage: false, token: '', debug: false };
      if (clientIndex === -1) clients.push(httpClient); else clients[clientIndex] = httpClient;
      await call(config, 'OB11Config/SetConfig', { config: JSON.stringify(updated) });
      // Persist after NapCat accepts the config. Verification is separate from saving:
      // hot reload may briefly restart its HTTP listener.
      saveQqConfig({ enabled: true, endpoint: config.onebotUrl, accessToken });
      return { ok: true, message: '消息配置已保存，正在等待 NapCat 服务生效；页面会自动检查连接' };
    } finally { connecting = false; }
  }

  const rememberAccount = userId => call(getConfig(), 'QQLogin/SetQuickLoginQQ', { uin: String(userId) });
  return { clear, status, refreshQr, connect, rememberAccount };
}
