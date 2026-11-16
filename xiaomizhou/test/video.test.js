import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseVideoConfig, videoShareLinks, videoRequests, videoMetadata, resolveVideo, downloadVideo, oneBotEvent, douyinDetailRequest } from '../qq-bridge.js';
import { videoTitle, mockVideoBytes, douyinItem, douyinPage, kuaishouPage } from '../video-fetch-mock.fixture.js';

const shareText = '4.87 复制打开抖音，看看【虾仁贵的作品】少年 难道你已到了怀疑自己 不是主角的时候了吗 #... https://v.douyin.com/JTYshwo88mc/ zTy:/ 05/15 :9pm h@B.Gi';
const incoming = (id, message = shareText, extra = {}) => ({ post_type: 'message', message_type: 'group', self_id: 999, group_id: 321, user_id: 123, message_id: id, message, ...extra });

test('video links need no command, accept complete share text and cards, and respect opt-in scope', () => {
  assert.deepEqual(videoShareLinks(shareText), [{ platform: 'douyin', url: 'https://v.douyin.com/JTYshwo88mc/' }]);
  const event = oneBotEvent(incoming(1));
  assert.equal(videoRequests(event, parseVideoConfig()).length, 0);
  const config = parseVideoConfig({ enabled: true, groupIds: ['321'], privateEnabled: false });
  assert.equal(videoRequests(event, config).length, 1);
  assert.equal(videoRequests({ ...event, chatId: '322' }, config).length, 0);
  assert.equal(videoRequests({ ...event, messageType: 'private' }, config).length, 0);
  assert.equal(videoRequests({ ...event, channel: 'qqbot' }, config).length, 0);
  assert.equal(videoRequests({ ...event, hasForward: true }, config).length, 0);
  assert.equal(videoRequests({ ...event, text: shareText + ' https://v.kuaishou.com/abcdef/' }, config).length, 1);
  const card = oneBotEvent(incoming(2, [{ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://v.kuaishou.com/abcdef/' } } }) } }]));
  assert.equal(videoRequests(card, config)[0].platform, 'kuaishou');
  assert.equal(oneBotEvent(incoming(3, [{ type: 'json', data: { data: '{broken json' } }])), null);
  assert.equal(oneBotEvent(incoming(4, [{ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'file:///etc/passwd', video: 'https://v.douyin.com/evil' } } }) } }])), null);
  for (const url of ['https://v.douyin.com.evil.example/a', 'http://127.0.0.1/a', 'https://douyin.com@evil.example/video/123', 'https://v.douyin.com:9000/a', 'https://www.douyin.com/user/abc']) assert.equal(videoShareLinks(url).length, 0);
  assert.equal(videoShareLinks('https://h5.pipix.com/s/abcdef/。')[0].platform, 'pipixia');
  assert.equal(videoShareLinks('https://www.douyin.com/jingxuan?modal_id=7704739451938884898')[0].platform, 'douyin');
});

test('video titles come only from platform data; uncertain Pipixia or watermarked URLs are refused', () => {
  assert.equal(videoMetadata('douyin', 'share', douyinPage).title, videoTitle);
  assert.equal(videoMetadata('kuaishou', 'share', kuaishouPage).title, '快手原平台标题');
  const item = { id: '123456', content: '皮皮虾原平台标题', video: { video_high: { url_list: [{ url: 'https://v3-ppx.ixigua.com/video.mp4' }] } } };
  const data = { data: { item } };
  assert.throws(() => videoMetadata('pipixia', 'share', data), /无法|未提供可确认/);
  // A comment with a different video must not replace the requested work.
  item.comments = [{ item: { video: item.video, author: item.author } }];
  assert.throws(() => videoMetadata('pipixia', 'share', data), /未提供可确认/);
  item.video.has_watermark = false;
  assert.equal(videoMetadata('pipixia', 'share', data).title, item.content);
  for (const url of ['https://evil.example/video.mp4', 'http://localhost/video.mp4', 'https://v3.douyinvod.com/video.mp4?watermark=1']) {
    const copy = structuredClone(douyinItem); copy.video.play_addr.url_list = [url];
    assert.throws(() => videoMetadata('douyin', 'share', { aweme_detail: copy }));
  }
  assert.throws(() => videoMetadata('douyin', 'share', '<script>window._ROUTER_DATA = (() => { throw new Error("executed"); })();</script>'), /未取得/);
  const copy = structuredClone(douyinItem); copy.desc = '';
  assert.throws(() => videoMetadata('douyin', 'share', { aweme_detail: copy }), /原平台标题/);
});

test('Douyin detail signing matches the upstream fixed interoperability vector', () => {
  const sequence = [2, 1234, 5678, 9012];
  const url = new URL(douyinDetailRequest('7450123456789012345', 1720000000123, () => sequence.shift()));
  assert.equal(url.searchParams.get('a_bogus'), 'E7mhBdugDifihdWk5l/LfY3q6fuVYmQ/0SVkMD2ffaDOJL39HMOk9exobQ4vpY2NZfmv2-ujy5kSYrrMicQnA3v6HSRKl2xp-g00t-P2so0j5ZhjCfuDnzfF-vzWt-Bd-Jd3Ech/ovKSKYi0AIee-wHvyhnFwo8sNiD4');
});

test('share and media redirects cannot escape platform allowlists; chunked oversize and fake videos are rejected', async () => {
  let requests = 0;
  await assert.rejects(resolveVideo({ platform: 'douyin', url: 'https://v.douyin.com/a' }, async () => {
    requests++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:8090/private' } });
  }), /链接|信任/);
  assert.equal(requests, 1);
  const metadata = videoMetadata('douyin', 'share', douyinPage);
  await assert.rejects(downloadVideo(metadata, 1, async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/video.mp4' } })), /信任/);
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700000)); controller.enqueue(new Uint8Array(700000)); controller.close(); } }), { headers: { 'Content-Type': 'video/mp4' } });
  await assert.rejects(downloadVideo(metadata, 1, async () => response), /大小上限/);
  await assert.rejects(downloadVideo(metadata, 1, async () => new Response('<html>login page</html>', { headers: { 'Content-Type': 'video/mp4' } })), /视频格式/);
  await assert.rejects(downloadVideo(metadata, 1, async () => new Response('challenge', { headers: { 'Content-Type': 'text/html' } })), /没有返回视频文件/);
  assert.deepEqual(await downloadVideo(metadata, 1, async () => new Response(mockVideoBytes, { headers: { 'Content-Type': 'video/mp4' } })), mockVideoBytes);
});

test('Douyin cookie is used only on the fixed official detail endpoint and results must match the requested work', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return String(url).includes('/aweme/v1/web/') ? Response.json({ aweme_detail: douyinItem }) : new Response('<script>window._ROUTER_DATA = {"loaderData":{}};</script>');
  };
  const link = { platform: 'douyin', url: 'https://www.iesdouyin.com/share/video/7704739451938884898/' };
  assert.equal((await resolveVideo(link, fetcher, { douyinCookie: 'sessionid=test' })).title, videoTitle);
  assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(new URL(calls[1].url).hostname, 'www.douyin.com');
  assert.equal(calls[1].options.headers.Cookie, 'sessionid=test');
  assert.equal(calls[1].options.redirect, 'error');
  await assert.rejects(resolveVideo(link, async url => String(url).includes('/aweme/v1/web/') ? Response.json({ aweme_detail: { ...douyinItem, aweme_id: 'wrong-work' } }) : new Response('empty')), /Cookie/);
  assert.equal(parseVideoConfig({ douyinCookie: '********' }, { douyinCookie: 'private-cookie' }).douyinCookie, 'private-cookie');
  assert.throws(() => parseVideoConfig({ douyinCookie: 'bad\r\nInjected: header' }));
});

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('real server auto-replies video then the exact title, handles scope, preserves secrets and resumes only the title after restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xiaomizhou-video-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const sent = [];
  let failTitle = false, child, cookie = '';
  const onebot = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    sent.push({ route: req.url, payload });
    const failing = failTitle && typeof payload.message === 'string';
    if (failing) failTitle = false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: failing ? 'failed' : 'ok', retcode: failing ? 100 : 0, data: {} }));
  });
  await new Promise(resolve => onebot.listen(0, '127.0.0.1', resolve));
  async function start() {
    child = spawn(process.execPath, ['--import', './video-fetch-mock.fixture.js', 'server.js'], { cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dir, PORT: String(port), XIAOMIZHOU_VIDEO_MOCK: '1' }, stdio: 'ignore' });
    for (let attempt = 0; attempt < 150; attempt++) {
      try { await fetch(base + '/api/bootstrap'); return; } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    throw new Error('Server did not start');
  }
  async function stop() { if (child && child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  async function request(route, method = 'GET', payload, webhook = false, signedIn = true) {
    const response = await fetch(base + route, { method, headers: { ...(signedIn ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...(webhook ? { 'X-Webhook-Token': token } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, result: await response.json() };
  }
  const fetches = () => existsSync(path.join(dir, 'video-fetches.jsonl')) ? readFileSync(path.join(dir, 'video-fetches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  let token;
  try {
    await start();
    assert.equal((await request('/api/videos')).status, 401);
    await request('/api/setup', 'POST', { username: 'admin', password: 'long-test-password' });
    token = (await request('/api/settings')).result.webhookToken;
    assert.equal((await request('/api/videos')).result.enabled, false);
    await request('/api/qq', 'PUT', { enabled: true, endpoint: `http://127.0.0.1:${onebot.address().port}` });
    assert.equal((await request('/api/qq/events', 'POST', incoming(1), true)).result.delivered, 0);
    assert.equal(fetches().length, 0);
    assert.equal((await request('/api/videos', 'PUT', { enabled: true, maxSizeMB: 100 })).status, 400);
    const config = { enabled: true, groupIds: ['321'], privateEnabled: false, maxSizeMB: 20, douyinCookie: 'sessionid=test-owned-cookie' };
    const saved = await request('/api/videos', 'PUT', config);
    assert.equal(saved.result.douyinCookie, '********');
    assert.equal((await request('/api/videos')).result.douyinCookie, '********');
    assert.equal((await request('/api/videos', 'PUT', { ...config, douyinCookie: '********' })).status, 200);
    assert.equal((await request('/api/qq/events', 'POST', incoming(2, shareText, { group_id: 322 }), true)).result.delivered, 0);
    assert.equal(fetches().length, 0);
    const first = await request('/api/qq/events', 'POST', incoming(3), true);
    assert.equal(first.status, 200);
    assert.equal(first.result.delivered, 2);
    assert.equal(first.result.actions[0].videoBytes, undefined);
    assert.equal(sent[0].payload.message[0].type, 'video');
    assert.deepEqual(Buffer.from(sent[0].payload.message[0].data.file.slice('base64://'.length), 'base64'), mockVideoBytes);
    assert.equal(sent[1].payload.message, videoTitle);
    assert.equal(sent[1].payload.auto_escape, true);
    const count = fetches().length;
    assert.equal((await request('/api/qq/events', 'POST', incoming(3), true)).result.delivered, 0);
    assert.equal(sent.length, 2); assert.equal(fetches().length, count);
    // Force the caption to fail after the video has already been accepted.
    failTitle = true;
    assert.equal((await request('/api/qq/events', 'POST', incoming(4), true)).status, 502);
    assert.equal(sent.length, 4);
    const beforeRestart = fetches().length;
    await stop(); await start();
    assert.equal((await request('/api/qq/events', 'POST', incoming(4), true)).result.delivered, 1);
    assert.equal(sent.length, 5);
    assert.equal(sent.at(-1).payload.message, videoTitle);
    assert.equal(fetches().length, beforeRestart, 'a delivered video must not be downloaded or sent again');
    // New Douyin share pages obtain their data from the official detail fallback.
    assert.equal((await request('/api/videos/test', 'POST', { text: 'https://v.douyin.com/detail/' })).status, 200);
    assert.ok(fetches().some(call => call.path === '/aweme/v1/web/aweme/detail/' && call.cookie === 'present'));
    const beforeTest = sent.length;
    const ks = await request('/api/videos/test', 'POST', { text: 'https://v.kuaishou.com/abcdef/' });
    assert.equal(ks.result.title, '快手原平台标题'); assert.equal(sent.length, beforeTest);
    const ppx = await request('/api/qq/events', 'POST', incoming(5, 'https://h5.pipix.com/item/123456/'), true);
    assert.equal(ppx.result.delivered, 1);
    assert.match(sent.at(-1).payload.message, /未提供可确认的无水印/);
    const logs = (await request('/api/logs?source=qq&area=video')).result.logs;
    assert.ok(logs.some(entry => entry.area === 'video' && entry.source === 'qq'));
    assert.ok(!JSON.stringify(logs).includes('test-owned-cookie'));
    assert.equal((await request('/api/videos/test', 'POST', { text: shareText }, false, false)).status, 401);
  } finally {
    await stop(); await new Promise(resolve => onebot.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
