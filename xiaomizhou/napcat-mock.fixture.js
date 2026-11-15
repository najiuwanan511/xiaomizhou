import http from 'node:http';
import crypto from 'node:crypto';

// Local-only fake for automated tests and UI review. Never authenticates a real QQ.
export async function startNapcatMock() {
  const state = {
    loggedIn: false, offline: false, loginError: '', token: 'mock-webui-token', credential: 'mock-credential',
    qr: 'https://example.com/qq-login-test-only', info: { uin: '123456789', nick: '小米粥测试账号' },
    config: { network: { httpServers: [], httpClients: [], websocketClients: [{ name: 'existing', url: 'ws://example.com' }] }, musicSignUrl: 'https://example.com/sign' },
    calls: [], logins: 0, writes: 0, apiUin: null, apiEnabled: false, rejectCredentials: 0, malformed: false
  };
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    state.calls.push({ path: req.url, body, authorization: req.headers.authorization });
    const send = (data, message = 'success', code = 0) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, data, message })); };
    if (req.url === '/api/auth/login') {
      state.logins++;
      if (body.hash !== crypto.createHash('sha256').update(`${state.token}.napcat`).digest('hex')) return send(null, 'token is invalid', -1);
      return send({ Credential: state.credential });
    }
    if (req.url === '/get_login_info') {
      const token = state.config.network.httpServers.find(entry => entry.name === 'xiaomizhou-http')?.token;
      if (!state.apiEnabled || !token || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(503); return res.end('{}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: state.apiUin || Number(state.info.uin), nickname: state.info.nick } }));
    }
    if (req.headers.authorization !== `Bearer ${state.credential}` || state.rejectCredentials-- > 0) return send(null, 'Unauthorized', -1);
    if (state.malformed) return send({ unexpected: true });
    if (req.url === '/api/QQLogin/CheckLoginStatus') return send({ isLogin: state.loggedIn, isOffline: state.offline, qrcodeurl: state.qr, loginError: state.loginError });
    if (req.url === '/api/QQLogin/GetQQLoginInfo') return send(state.info);
    if (req.url === '/api/QQLogin/SetQuickLoginQQ') { state.autoLoginAccount = body.uin; return send(null); }
    if (req.url === '/api/QQLogin/RefreshQRcode') { state.qr += '?refreshed=1'; return send(null); }
    if (req.url === '/api/OB11Config/GetConfig') return send(state.config);
    if (req.url === '/api/OB11Config/SetConfig') { state.config = JSON.parse(body.config); state.writes++; state.apiEnabled = true; return send(null); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
