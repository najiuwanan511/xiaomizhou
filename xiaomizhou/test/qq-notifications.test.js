import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseQqNotificationConfig, publicQqNotificationConfig, sendQqNotification, sendQqNotificationEmail, createQqOfflineNotifier } from '../napcat-manager.js';
import { startNapcatMock } from '../napcat-mock.fixture.js';

const config = overrides => parseQqNotificationConfig({ enabled: true, provider: 'pushplus', pushplusToken: 'test-notification-token', delaySeconds: 60, ...overrides });
const online = { state: 'online', account: { userId: '123456789', nickname: '测试 QQ' } };

test('notification configuration validates channels, delay, secrets and email headers', () => {
  assert.equal(parseQqNotificationConfig({}).enabled, false);
  assert.equal(parseQqNotificationConfig({}).delaySeconds, 60);
  const saved = config({ smtpPassword: 'email-code' });
  assert.equal(publicQqNotificationConfig(saved).pushplusToken, '********');
  assert.equal(publicQqNotificationConfig(saved).smtpPassword, '********');
  assert.equal(parseQqNotificationConfig({ ...saved, pushplusToken: '********' }, saved).pushplusToken, saved.pushplusToken);
  for (const values of [{ provider: 'other' }, { delaySeconds: 0 }, { delaySeconds: 60.5 }, { delaySeconds: 3601 }, { pushplusToken: '' }, { provider: 'wecom', wecomKey: 'https://evil.example/send?key=1234567890' }, { smtpHost: 'a\r\nb' }, { smtpPort: -1 }, { provider: 'email', smtpHost: 'smtp.qq.com', smtpUser: 'me', smtpPassword: 'code', smtpFrom: 'me@example.com', smtpTo: 'you@example.com\r\nBcc: third@example.com' }]) assert.throws(() => config(values), error => error.status === 400);
});

test('PushPlus and WeCom notification transports enforce fixed HTTPS endpoints and check application failures', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url.includes('pushplus') ? { code: 200 } : { errcode: 0 } }; };
  await sendQqNotification(config(), '掉线提醒', '测试内容', { fetcher });
  assert.equal(calls[0].url, 'https://www.pushplus.plus/send');
  assert.deepEqual(JSON.parse(calls[0].options.body), { token: 'test-notification-token', title: '掉线提醒', content: '测试内容', template: 'txt' });
  assert.equal(calls[0].options.redirect, 'error');
  await sendQqNotification(config({ provider: 'wecom', wecomKey: 'robot-key-123456' }), '恢复提醒', '已上线', { fetcher });
  assert.equal(calls[1].url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=robot-key-123456');
  assert.deepEqual(JSON.parse(calls[1].options.body), { msgtype: 'text', text: { content: '恢复提醒\n已上线' } });
  await assert.rejects(sendQqNotification(config(), '标题', '正文', { fetcher: async () => ({ ok: true, json: async () => ({ code: 600, msg: 'private-secret' }) }) }), error => /600/.test(error.message) && !error.message.includes('private-secret'));
  await assert.rejects(sendQqNotification(config(), '标题', '正文', { fetcher: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(sendQqNotification(config(), '标题', '正文', { fetcher: async () => { throw new Error('token=secret'); } }), error => !error.message.includes('secret'));
});

test('SMTP uses verified TLS, a bounded LOGIN exchange and MIME-encoded Chinese content', async () => {
  const mail = config({ provider: 'email', smtpHost: 'smtp.example.com', smtpUser: 'me@example.com', smtpPassword: 'test-mail-code', smtpFrom: 'me@example.com', smtpTo: 'you@example.com' });
  let connectionOptions, commands = [];
  const connect = options => {
    connectionOptions = options;
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.destroy = () => socket.emit('close'); socket.end = () => {};
    const codes = ['250-example.com\r\n250 AUTH LOGIN\r\n', '334 username\r\n', '334 password\r\n', '235 accepted\r\n', '250 sender\r\n', '250 recipient\r\n', '354 data\r\n', '250 queued\r\n'];
    socket.write = command => { commands.push(command); queueMicrotask(() => socket.emit('data', codes.shift())); };
    queueMicrotask(() => { socket.emit('data', '220 ser'); socket.emit('data', 'ver ready\r\n'); });
    return socket;
  };
  await sendQqNotificationEmail(mail, 'QQ 已掉线', '账号：123\n请重新扫码。', connect);
  assert.equal(connectionOptions.rejectUnauthorized, true); assert.equal(connectionOptions.minVersion, 'TLSv1.2'); assert.equal(connectionOptions.port, 465);
  assert.equal(commands[0], 'EHLO xiaomizhou\r\n');
  assert.equal(commands[3], Buffer.from('test-mail-code').toString('base64') + '\r\n');
  assert.match(commands[7], /Subject: =\?UTF-8\?B\?/);
  const body = commands[7].split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, '');
  assert.equal(Buffer.from(body, 'base64').toString(), '账号：123\n请重新扫码。');
});

test('SMTP rejection and connection errors never expose authorization codes or arbitrary server responses', async () => {
  const options = config({ provider: 'email', smtpHost: 'smtp.example.com', smtpUser: 'me@example.com', smtpPassword: 'private-mail-secret', smtpFrom: 'me@example.com', smtpTo: 'you@example.com' });
  function rejectConnection() {
    const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.destroy = () => {}; socket.end = () => {};
    socket.write = () => queueMicrotask(() => socket.emit('data', '535 private-mail-secret\r\n'));
    queueMicrotask(() => socket.emit('data', '220 ready\r\n')); return socket;
  }
  await assert.rejects(sendQqNotificationEmail(options, '标题', '正文', rejectConnection), error => /SMTP 535/.test(error.message) && !error.message.includes('private-mail-secret'));
});

test('offline notifier ignores first login and brief interruptions, sends once and then reports recovery', async () => {
  let time = 1700000000000, persisted;
  const messages = [];
  const notifier = createQqOfflineNotifier({ getConfig: () => config(), clock: () => time, send: async (...message) => messages.push(message), saveState: state => { persisted = state; } });
  await notifier.tick({ state: 'waiting' }); time += 120000; await notifier.tick({ state: 'unreachable' }); assert.equal(messages.length, 0);
  await notifier.tick(online);
  await notifier.tick({ state: 'offline' }); time += 59000; await notifier.tick({ state: 'offline' }); assert.equal(messages.length, 0);
  await notifier.tick(online); assert.equal(messages.length, 0);
  await notifier.tick({ state: 'unreachable', error: '连接失败' }); time += 60000;
  await notifier.tick({ state: 'unreachable', error: '连接失败' }); assert.equal(messages.length, 1);
  assert.match(messages[0][1], /掉线或连接异常/); assert.match(messages[0][2], /123456789/); assert.match(messages[0][2], /连接失败/);
  time += 300000; await notifier.tick({ state: 'offline' }); assert.equal(messages.length, 1);
  const resumed = createQqOfflineNotifier({ getConfig: () => config(), clock: () => time, loadState: () => persisted, send: async (...message) => messages.push(message) });
  await resumed.tick({ state: 'offline' }); assert.equal(messages.length, 1, 'restart does not repeat a delivered outage notification');
  await resumed.tick(online); assert.equal(messages.length, 2); assert.match(messages[1][1], /恢复上线/);
  await resumed.tick(online); assert.equal(messages.length, 2);
});

test('failed notifications retry with backoff and a recovered unsent outage does not send stale alerts', async () => {
  let time = 1700000000000, attempts = 0, fail = true;
  const notifier = createQqOfflineNotifier({ getConfig: () => config(), clock: () => time, send: async () => { attempts++; if (fail) throw new Error('网络不可达'); } });
  await notifier.tick(online); await notifier.tick({ state: 'offline' }); time += 60000;
  await notifier.tick({ state: 'offline' }); assert.equal(attempts, 1); assert.equal(notifier.status().lastError, '网络不可达');
  time += 59000; await notifier.tick({ state: 'offline' }); assert.equal(attempts, 1);
  time += 1000; await notifier.tick({ state: 'offline' }); assert.equal(attempts, 2);
  fail = false; await notifier.tick(online); time += 300000; await notifier.tick(online); assert.equal(attempts, 2);
  assert.equal(notifier.status().lastError, null); assert.equal(notifier.status().offlineSince, null);
});

test('notifications honor disable/recovery options and serialize overlapping send attempts', async () => {
  let time = 1700000000000, enabled = false, recovery = false, pending, count = 0;
  const notifier = createQqOfflineNotifier({ getConfig: () => config({ enabled, recovery }), clock: () => time, send: () => { count++; return new Promise(resolve => { pending = resolve; }); } });
  await notifier.tick(online); assert.equal(notifier.status().armed, false);
  enabled = true; await notifier.tick(online); await notifier.tick({ state: 'waiting' }); time += 60000;
  const first = notifier.tick({ state: 'waiting' }); await notifier.tick({ state: 'waiting' }); assert.equal(count, 1);
  pending(); await first; await notifier.tick(online); assert.equal(count, 1); assert.equal(notifier.status().offlineSince, null);
});

test('a failed recovery notification is retried without sending a stale recovery during a new interruption', async () => {
  let time = 1700000000000, failRecovery = true;
  const titles = [];
  const notifier = createQqOfflineNotifier({ getConfig: () => config(), clock: () => time, send: async (options, title) => { titles.push(title); if (title.includes('恢复') && failRecovery) throw new Error('暂时不可达'); } });
  await notifier.tick(online); await notifier.tick({ state: 'offline' }); time += 60000;
  await notifier.tick({ state: 'offline' }); await notifier.tick(online); assert.equal(titles.length, 2);
  time += 60000; await notifier.tick({ state: 'offline' }); assert.equal(titles.length, 2, 'no recovery is sent while QQ is offline');
  failRecovery = false; await notifier.tick(online); assert.equal(titles.length, 3);
  assert.match(titles[2], /恢复/); assert.equal(notifier.status().offlineNotified, false);
  await notifier.tick(online); assert.equal(titles.length, 3);
});

async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail(label);
}

test('background monitor notifies without an open page, preserves state on restart, and protects configuration APIs', async t => {
  const mock = await startNapcatMock(); t.after(mock.close); mock.state.loggedIn = true;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xmz-notify-'));
  const clockFile = path.join(dataDir, 'clock'), captureFile = path.join(dataDir, 'notifications.jsonl'); writeFileSync(clockFile, '0');
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  let child, exited;
  const start = () => {
    child = spawn(process.execPath, ['--import', './qq-notification-fetch-mock.fixture.js', 'server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), NAPCAT_WEBUI_URL: mock.base, NAPCAT_WEBUI_TOKEN: mock.state.token, QQ_NOTIFY_TEST_CLOCK: clockFile, QQ_NOTIFY_TEST_CAPTURE: captureFile }, stdio: 'ignore' });
    exited = once(child, 'exit');
  };
  const stop = async () => { child.kill(); await exited; };
  t.after(async () => { await stop(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`; let cookie = '';
  const request = async (url, method = 'GET', body) => {
    const res = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, result: await res.json() };
  };
  start(); await waitFor(async () => { try { return (await request('/bootstrap')).status === 200; } catch { return false; } }, 'server starts');
  assert.equal((await request('/qq/notifications')).status, 401);
  assert.equal((await request('/qq/notifications', 'PUT', config())).status, 401);
  assert.equal((await request('/qq/notifications/test', 'POST')).status, 401);
  await request('/setup', 'POST', { username: 'admin', password: 'notification-test-password' });
  assert.equal((await request('/qq/notifications')).result.enabled, false);
  assert.equal((await request('/qq/notifications', 'PUT', { ...config(), delaySeconds: 0 })).status, 400);
  const saved = await request('/qq/notifications', 'PUT', config({ delaySeconds: 30 })); assert.equal(saved.status, 200); assert.equal(saved.result.pushplusToken, '********');
  assert.equal((await request('/qq/notifications', 'PUT', { ...saved.result, pushplusToken: '********' })).status, 200);
  const db = new DatabaseSync(path.join(dataDir, 'ownman.db'));
  const state = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='qq.notifications.state'").get()?.value || '{}');
  const messages = () => existsSync(captureFile) ? readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  await waitFor(() => state().armed, 'monitor arms in background');
  mock.state.loggedIn = false; mock.state.offline = true;
  await waitFor(() => state().offlineSince != null, 'monitor notices outage in background');
  assert.equal(messages().length, 0); writeFileSync(clockFile, '31000');
  await waitFor(() => state().offlineNotified, 'monitor submits one offline notification'); assert.equal(messages().length, 1);
  await stop(); start(); await waitFor(async () => { try { return (await request('/bootstrap')).status === 200; } catch { return false; } }, 'server restarts');
  const previousCheck = state().lastCheckedAt; await waitFor(() => state().lastCheckedAt !== previousCheck, 'monitor resumes after restart');
  assert.equal(messages().length, 1);
  mock.state.loggedIn = true; mock.state.offline = false;
  await waitFor(() => messages().length === 2, 'monitor submits recovery notification'); assert.match(messages()[1].title, /恢复上线/);
  assert.equal((await request('/qq/notifications/test', 'POST')).status, 200);
  assert.equal((await request('/qq/notifications/test', 'POST')).status, 429);
  assert.equal(messages().length, 3);
  const logs = JSON.stringify((await request('/logs?source=qq')).result);
  assert.ok(logs.includes('掉线通知已提交')); assert.ok(logs.includes('恢复通知已提交'));
  assert.ok(!logs.includes('test-notification-token')); assert.ok(!logs.includes(mock.state.token));
  db.close();
});
