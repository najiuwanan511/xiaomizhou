// Deterministic platform responses for automated tests; no real account or media.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const videoTitle = '少年，原平台完整标题 #测试 [CQ:at,qq=all]';
export const mockVideoBytes = Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex');
export const douyinItem = { aweme_id: '7704739451938884898', desc: videoTitle, video: { play_addr: { url_list: ['https://v3.douyinvod.com/video.mp4'] } } };
export const douyinPage = `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [douyinItem] } } } })};</script>`;
export const kuaishouPage = `<script>window.INIT_STATE = ${JSON.stringify({ detail: { result: 1, photo: { id: 'ks123', caption: '快手原平台标题', mainMvUrls: [{ url: 'https://txmov2.a.kwimgs.com/video.mp4' }] } } })};</script>`;

// Merely importing fixtures from a unit test must not modify that test's fetch.
if (process.env.XIAOMIZHOU_VIDEO_MOCK === '1') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return originalFetch(input, options);
    fs.appendFileSync(path.join(process.env.DATA_DIR, 'video-fetches.jsonl'), JSON.stringify({ host: url.hostname, path: url.pathname, cookie: options.headers?.Cookie ? 'present' : 'absent' }) + '\n');
    if (url.hostname === 'v.douyin.com') return new Response(null, { status: 302, headers: { Location: `https://www.iesdouyin.com/share/video/7704739451938884898/${url.pathname.includes('detail') ? '?detail=1' : ''}` } });
    if (url.hostname === 'www.iesdouyin.com') return new Response(url.searchParams.has('detail') ? '<script>window._ROUTER_DATA = {"loaderData":{}};</script>' : douyinPage);
    if (url.hostname === 'www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/detail/') {
      assert.equal(options.redirect, 'error');
      assert.ok(url.searchParams.get('a_bogus'));
      assert.equal(options.headers.Cookie, 'sessionid=test-owned-cookie');
      return Response.json({ aweme_detail: douyinItem });
    }
    if (url.hostname === 'v.kuaishou.com') return new Response(kuaishouPage);
    if (url.hostname === 'h5.pipix.com') return new Response('<html>作品页面</html>');
    if (url.hostname === 'api.pipix.com') return Response.json({ data: { cell_comments: [{ comment_info: { item: { id: '123456', content: '皮皮虾标题', video: { video_high: { url_list: [{ url: 'https://v3-ppx.ixigua.com/video.mp4' }] } } } } }] } });
    if (['v3.douyinvod.com', 'txmov2.a.kwimgs.com'].includes(url.hostname)) {
      assert.equal(options.headers?.Cookie, undefined, 'a media CDN must never receive the Douyin session cookie');
      return new Response(mockVideoBytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mockVideoBytes.length) } });
    }
    throw new Error(`Unexpected external request in video test: ${url.hostname}${url.pathname}`);
  };
}
