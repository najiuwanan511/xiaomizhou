import crypto from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';
import QRCode from 'qrcode';
import { oneBotCall } from './qq-bridge.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const upstreamError = message => Object.assign(new Error(message), { status: 502 });

export function qqFramework(value = 'napcat') {
  if (!['napcat', 'snowcat'].includes(value)) throw invalid('QQ 框架只支持 NapCat 或 SnowCat');
  return { id: value, name: value === 'snowcat' ? 'SnowCat' : 'NapCat' };
}

export function napcatBaseUrl(value, label) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw invalid(`${label}需要填写完整的 HTTP 地址`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw invalid(`${label}只填写协议、主机和端口，不带路径、令牌或查询参数`);
  }
  return url.origin;
}

export function parseNapcatConfig(input, old = {}) {
  const framework = qqFramework(input.framework ?? old.framework ?? 'napcat').id;
  const name = qqFramework(framework).name;
  if (framework !== (old.framework || 'napcat') && input.webuiToken === '********') throw invalid('切换 QQ 框架时请填写新框架的 WebUI Token');
  const webuiUrl = input.webuiUrl ? napcatBaseUrl(input.webuiUrl, `${name} 管理地址`) : '';
  const onebotUrl = input.onebotUrl ? napcatBaseUrl(input.onebotUrl, '消息 API 地址') : '';
  const callbackBaseUrl = input.callbackBaseUrl ? napcatBaseUrl(input.callbackBaseUrl, '小米粥访问地址') : '';
  const webuiToken = input.webuiToken === '********' ? old.webuiToken || '' : String(input.webuiToken || '');
  if (webuiToken.length > 1000) throw invalid(`${name} WebUI Token 过长`);
  return { framework, webuiUrl, webuiToken, onebotUrl, callbackBaseUrl };
}

// Match the retained NapCat WebUI API: SHA-256(token + '.napcat'), then Bearer Credential.
// Credentials and QR payloads live in server memory only and are never logged.
export function createNapcatManager({ getConfig, getQqConfig, fetcher = fetch }) {
  let session = null;
  let qrCache = null;
  let connecting = false;
  const clear = () => { session = null; qrCache = null; };

  async function request(config, action, payload = {}, credential = '') {
    const name = qqFramework(config.framework).name;
    let response;
    try {
      response = await fetcher(`${config.webuiUrl}/api/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(6000)
      });
    } catch { throw upstreamError(`无法连接 ${name}，请检查服务是否启动及管理地址是否可访问`); }
    if (response.status === 401 || response.status === 403) throw Object.assign(upstreamError(`${name} 管理凭证已失效`), { auth: true });
    if (!response.ok) throw upstreamError(`${name} 管理接口 HTTP ${response.status}，请检查地址和版本`);
    const result = await response.json().catch(() => null);
    if (!result || typeof result.code !== 'number') throw upstreamError(`${name} 管理接口响应不兼容，请检查地址和版本`);
    if (result.code !== 0) {
      const auth = /unauthorized|authorization|credential|token.*(invalid|expired|revoked)/i.test(result.message || '');
      // Do not relay arbitrary upstream messages, which can contain credentials or URLs.
      throw Object.assign(upstreamError(auth ? `${name} WebUI Token 不正确或凭证失效${config.framework === 'snowcat' ? '；若登录成功后仍被拒绝，请检查 SnowCat 的凭证校验版本' : ''}` : `${name} 操作失败（${action.split('/').at(-1)}），请查看内核日志`), { auth });
    }
    return result.data;
  }

  async function credential(config) {
    const key = crypto.createHash('sha256').update(`${config.framework || 'napcat'}\0${config.webuiUrl}\0${config.webuiToken}`).digest('hex');
    if (session?.key === key && session.expires > Date.now()) {
      if (session.error) throw session.error;
      return session.pending;
    }
    const current = {
      key, expires: Date.now() + 50 * 60 * 1000,
      pending: request(config, 'auth/login', { hash: crypto.createHash('sha256').update(`${config.webuiToken}.napcat`).digest('hex') })
        .then(data => {
          const name = qqFramework(config.framework).name;
          if (data?.require2FA) throw Object.assign(upstreamError(`${name} 已启用两步验证，当前自动管理接口暂不支持；可保留两步验证并使用手动 OneBot 接入`), { auth: true });
          if (typeof data?.Credential !== 'string' || !data.Credential) throw upstreamError(`${name} 未返回管理凭证，请检查版本`);
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
    if (!config.webuiUrl || !config.webuiToken) throw invalid(`请先保存 ${qqFramework(config.framework).name} 管理地址和 WebUI Token`);
    const token = await credential(config);
    try { return await request(config, action, payload, token); }
    catch (error) {
      if (!error.auth) throw error;
      session = null;
      try { return await request(config, action, payload, await credential(config)); }
      catch (retryError) {
        // Cache unusable issued credentials to avoid exhausting login limits.
        if (retryError.auth && session) { session.error = retryError; session.expires = Date.now() + 60000; }
        throw retryError;
      }
    }
  }

  async function status() {
    const config = getConfig();
    const framework = qqFramework(config.framework);
    const result = { framework: framework.id, configured: !!(config.webuiUrl && config.webuiToken), reachable: false, state: 'unconfigured', account: null, qrCode: null, messageConnected: false, checkedAt: new Date().toISOString(), error: null };
    if (!result.configured) return result;
    let login;
    try {
      login = await call(config, 'QQLogin/CheckLoginStatus');
      if (typeof login?.isLogin !== 'boolean') throw upstreamError(`${framework.name} 登录状态响应不兼容`);
      result.reachable = true;
      result.loginPhase = typeof login.loginPhase === 'string' ? login.loginPhase : null;
      result.state = login.isOffline || ['offline', 'reconnecting'].includes(login.loginPhase) ? 'offline'
        : ['qrcode_scanned', 'initializing'].includes(login.loginPhase) || login.coreReady === false && login.isLogin ? 'initializing'
        : login.isLogin ? 'online' : 'waiting';
    } catch (error) {
      return { ...result, state: error.auth ? 'auth-error' : 'unreachable', error: error.message };
    }
    if (result.state === 'online' || result.state === 'offline') {
      try {
        const info = await call(config, 'QQLogin/GetQQLoginInfo');
        result.account = { userId: String(info?.uin || ''), nickname: String(info?.nick || '') };
      } catch (error) { result.error = error.message; }
      qrCache = null;
    } else if (result.state === 'waiting' && typeof login.qrcodeurl === 'string' && login.qrcodeurl && login.qrcodeurl.length <= 2048) {
      // This is the QQ login URL to encode, not a remote image to fetch.
      if (qrCache?.value !== login.qrcodeurl) qrCache = { value: login.qrcodeurl, image: await QRCode.toDataURL(login.qrcodeurl, { width: 256, margin: 2, errorCorrectionLevel: 'M' }) };
      result.qrCode = qrCache.image;
    }
    if (login.loginError) result.error = `QQ 登录异常，请检查${result.state === 'offline' ? '内核状态或重新登录' : '二维码是否过期'}；详细原因见 ${framework.name} 日志`;
    const qq = getQqConfig();
    if (result.state === 'online' && qq.enabled && qq.endpoint && result.account?.userId) {
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
      if (endpoint.protocol !== 'http:') throw invalid('自动接通需要 QQ 内核直接提供的 HTTP 地址；HTTPS 反向代理请使用手动接入');
      const login = await call(config, 'QQLogin/CheckLoginStatus');
      if (!login?.isLogin || login.isOffline || login.coreReady === false || ['offline', 'reconnecting', 'initializing', 'qrcode_scanned'].includes(login.loginPhase)) throw Object.assign(new Error('请先使用手机 QQ 扫码并确认登录，等待内核就绪'), { status: 409 });
      const current = await call(config, 'OB11Config/GetConfig');
      if (!current?.network || !Array.isArray(current.network.httpServers) || !Array.isArray(current.network.httpClients)) throw upstreamError('QQ 内核网络配置格式不兼容，未修改配置');
      const updated = structuredClone(current);
      const port = Number(endpoint.port || 80);
      const servers = updated.network.httpServers;
      const clients = updated.network.httpClients;
      const namedServer = servers.findIndex(server => server.name === 'xiaomizhou-http');
      const portServer = servers.findIndex(server => Number(server.port) === port && server.enable);
      if (portServer !== -1 && portServer !== namedServer) throw Object.assign(new Error('消息 API 端口已被其他 QQ HTTP 服务使用。请换一个空闲端口，或在手动接入中连接已有服务'), { status: 409 });
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
      saveQqConfig({ enabled: true, endpoint: config.onebotUrl, accessToken, framework: config.framework || 'napcat' });
      return { ok: true, message: `消息配置已保存，正在等待 ${qqFramework(config.framework).name} 服务生效；页面会自动检查连接` };
    } finally { connecting = false; }
  }

  const rememberAccount = userId => call(getConfig(), 'QQLogin/SetQuickLoginQQ', { uin: String(userId) });
  return { clear, status, refreshQr, connect, rememberAccount };
}

const notificationSecrets = ['pushplusToken', 'wecomKey', 'smtpPassword'];
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
export function parseQqNotificationConfig(input, old = {}) {
  const config = { enabled: input.enabled === true, provider: input.provider || 'pushplus', delaySeconds: Number(input.delaySeconds ?? 60), recovery: input.recovery !== false };
  if (!['pushplus', 'wecom', 'email'].includes(config.provider)) throw invalid('请选择有效的通知渠道');
  if (!Number.isInteger(config.delaySeconds) || config.delaySeconds < 30 || config.delaySeconds > 3600) throw invalid('掉线等待时间应为 30–3600 秒');
  for (const key of [...notificationSecrets, 'smtpHost', 'smtpUser', 'smtpFrom', 'smtpTo']) {
    config[key] = input[key] === '********' && notificationSecrets.includes(key) ? old[key] || '' : String(input[key] ?? old[key] ?? '').trim();
    if (config[key].length > 1000 || /[\r\n\0]/.test(config[key])) throw invalid('通知配置过长或包含无效字符');
  }
  config.smtpPort = Number(input.smtpPort ?? old.smtpPort ?? 465);
  if (!Number.isInteger(config.smtpPort) || config.smtpPort < 1 || config.smtpPort > 65535) throw invalid('SMTP 端口无效');
  if (config.enabled) {
    if (config.provider === 'pushplus' && !/^[A-Za-z0-9_-]{10,200}$/.test(config.pushplusToken)) throw invalid('请填写 PushPlus Token');
    if (config.provider === 'wecom' && !/^[A-Za-z0-9_-]{10,200}$/.test(config.wecomKey)) throw invalid('请填写企业微信机器人的 Webhook key');
    if (config.provider === 'email' && (!/^[A-Za-z0-9.-]{1,253}$/.test(config.smtpHost) || !config.smtpUser || !config.smtpPassword || !mailbox.test(config.smtpFrom) || !mailbox.test(config.smtpTo))) throw invalid('请填写 SMTP 服务器、账号、授权码、发件人与收件人邮箱');
  }
  return config;
}
export function publicQqNotificationConfig(config) {
  return { ...config, ...Object.fromEntries(notificationSecrets.map(key => [key, config[key] ? '********' : ''])) };
}

// Implicit TLS SMTP (normally port 465). Never send an authorization code over plaintext.
export async function sendQqNotificationEmail(config, title, content, connect = tls.connect) {
  config = parseQqNotificationConfig({ ...config, enabled: true, provider: 'email' });
  const socket = connect({ host: config.smtpHost, port: config.smtpPort, servername: net.isIP(config.smtpHost) ? undefined : config.smtpHost, minVersion: 'TLSv1.2', rejectUnauthorized: true });
  let buffer = '', pending, failed, size = 0;
  const replies = [];
  const abort = error => { failed = error; if (pending) { const waiting = pending; pending = null; waiting.reject(error); } };
  socket.setEncoding('utf8');
  socket.on('error', () => abort(new Error('SMTP 安全连接失败，请检查服务器、证书和端口')));
  socket.on('close', () => abort(new Error('SMTP 连接已关闭')));
  socket.on('data', chunk => {
    size += chunk.length;
    if (size > 65536) { abort(new Error('SMTP 响应过大')); socket.destroy(); return; }
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!/^\d{3}[- ]/.test(line)) { abort(new Error('SMTP 响应格式无效')); socket.destroy(); return; }
      if (line[3] === ' ') {
        const code = Number(line.slice(0, 3));
        if (pending) { const waiting = pending; pending = null; waiting.resolve(code); }
        else replies.push(code);
      }
    }
  });
  const read = () => failed ? Promise.reject(failed) : replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve, reject) => { pending = { resolve, reject }; });
  const command = async (text, codes, stage) => {
    if (text != null) socket.write(text + '\r\n');
    const code = await read();
    if (!codes.includes(code)) throw new Error(`邮件发送失败：${stage}（SMTP ${code}）`);
  };
  const timer = setTimeout(() => { abort(new Error('邮件发送超时，请检查 SMTP 服务')); socket.destroy(); }, 20000);
  try {
    await command(null, [220], '服务器未就绪');
    await command('EHLO xiaomizhou', [250], '握手失败');
    await command('AUTH LOGIN', [334], '服务器不支持账号登录');
    await command(Buffer.from(config.smtpUser).toString('base64'), [334], '账号验证失败');
    await command(Buffer.from(config.smtpPassword).toString('base64'), [235], '授权码验证失败');
    await command(`MAIL FROM:<${config.smtpFrom}>`, [250], '发件地址被拒绝');
    await command(`RCPT TO:<${config.smtpTo}>`, [250, 251], '收件地址被拒绝');
    await command('DATA', [354], '服务器拒绝邮件正文');
    const titleCharacters = Array.from(title), encodedWords = [];
    for (let i = 0; i < titleCharacters.length; i += 10) encodedWords.push(`=?UTF-8?B?${Buffer.from(titleCharacters.slice(i, i + 10).join('')).toString('base64')}?=`);
    const body = Buffer.from(content).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
    const message = [`From: <${config.smtpFrom}>`, `To: <${config.smtpTo}>`, `Subject: ${encodedWords.join('\r\n ')}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@xiaomizhou.local>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body, '.'].join('\r\n');
    await command(message, [250], '服务器未接受邮件');
    socket.end('QUIT\r\n');
  } finally { clearTimeout(timer); socket.destroy(); }
}

export async function sendQqNotification(config, title, content, { fetcher = fetch, email = sendQqNotificationEmail } = {}) {
  config = parseQqNotificationConfig({ ...config, enabled: true });
  if (config.provider === 'email') return email(config, title, content);
  const url = config.provider === 'pushplus' ? 'https://www.pushplus.plus/send' : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(config.wecomKey)}`;
  const payload = config.provider === 'pushplus' ? { token: config.pushplusToken, title, content, template: 'txt' } : { msgtype: 'text', text: { content: `${title}\n${content}` } };
  let response;
  try { response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('通知渠道连接失败或超时，请检查网络'); }
  if (!response.ok) throw new Error(`通知渠道请求失败（HTTP ${response.status}）`);
  const result = await response.json().catch(() => null);
  const code = config.provider === 'pushplus' ? result?.code : result?.errcode;
  if (code !== (config.provider === 'pushplus' ? 200 : 0)) throw new Error(`通知渠道拒绝请求（错误码：${typeof code === 'number' ? code : '响应格式无效'}），请检查令牌和接收设置`);
}

export function createQqOfflineNotifier({ getConfig, loadState = () => ({}), saveState = () => {}, send = sendQqNotification, log = () => {}, clock = Date.now }) {
  let state = { armed: false, account: null, offlineSince: null, offlineNotified: false, attempts: 0, nextAttemptAt: 0, lastError: null, lastNotificationAt: null, ...loadState() };
  let busy = false;
  const persist = () => saveState({ ...state });
  const status = () => ({ armed: state.armed, account: state.account, offlineSince: state.offlineSince, offlineNotified: state.offlineNotified, lastCheckedAt: state.lastCheckedAt || null, lastNotificationAt: state.lastNotificationAt, lastError: state.lastError, nextAttemptAt: state.nextAttemptAt || null });
  async function tick(sample) {
    if (busy || !getConfig().enabled) return;
    busy = true;
    try {
      const config = getConfig(), time = clock();
      state.lastCheckedAt = new Date(time).toISOString();
      let kind;
      if (sample.state === 'online') {
        state.armed = true;
        if (sample.account?.userId) state.account = { userId: String(sample.account.userId).slice(0, 40), nickname: String(sample.account.nickname || '').slice(0, 80) };
        if (state.offlineNotified && config.recovery) kind = 'recovery';
        else { state.offlineSince = null; state.offlineNotified = false; state.attempts = 0; state.nextAttemptAt = 0; state.lastError = null; }
      } else if (state.armed && sample.state !== 'unconfigured') {
        if (state.offlineSince == null) { state.offlineSince = time; state.nextAttemptAt = 0; }
        if (!state.offlineNotified && time - state.offlineSince >= config.delaySeconds * 1000) kind = 'offline';
      }
      persist();
      if (!kind || time < state.nextAttemptAt) return;
      const title = kind === 'offline' ? '【小米粥】QQ 掉线或连接异常' : '【小米粥】QQ 已恢复上线';
      const labels = { offline: 'QQ 已掉线', waiting: 'QQ 当前等待重新扫码', unreachable: '无法连接 NapCat 或消息接口', 'auth-error': 'NapCat 管理接口鉴权失败' };
      const format = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      const content = [`QQ：${state.account?.nickname || '个人 QQ'}（${state.account?.userId || '未知账号'}）`, `发现异常：${format(state.offlineSince)}`, `${kind === 'offline' ? '提醒' : '恢复'}时间：${format(time)}（北京时间）`, kind === 'offline' ? `状态：${labels[sample.state] || '连接异常'}${sample.error ? `\n原因：${String(sample.error).slice(0, 300)}` : ''}` : `本次异常持续约 ${Math.max(1, Math.round((time - state.offlineSince) / 60000))} 分钟`, kind === 'offline' ? '请打开小米粥「个人 QQ」查看状态，必要时重新扫码。' : 'QQ 已在线，请在小米粥确认消息收发状态。'].join('\n');
      try {
        await send(config, title, content);
        state.lastNotificationAt = new Date(clock()).toISOString(); state.lastError = null; state.attempts = 0; state.nextAttemptAt = 0;
        if (kind === 'offline') state.offlineNotified = true;
        else { state.offlineNotified = false; state.offlineSince = null; }
        log('info', `QQ ${kind === 'offline' ? '掉线' : '恢复'}通知已提交至${{ pushplus: 'PushPlus', wecom: '企业微信机器人', email: '邮件服务器' }[config.provider]}`);
      } catch (error) {
        state.attempts++; state.nextAttemptAt = clock() + Math.min(300000, 60000 * 2 ** Math.min(state.attempts - 1, 3));
        state.lastError = error.message;
        log('error', `QQ ${kind === 'offline' ? '掉线' : '恢复'}通知发送失败：${error.message}；将自动重试`);
      }
      persist();
    } finally { busy = false; }
  }
  return { tick, status };
}
