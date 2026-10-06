import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';

test('real server pipeline delivers QQ Bot rebate images for private and group replies, respecting switch and fallback', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xiaomizhou-qqbot-images-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--import', './qqbot-fetch-mock.fixture.js', 'server.js'], {
    cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) }, stdio: 'ignore'
  });
  let cookie = '';
  const base = `http://127.0.0.1:${port}`;
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  const calls = () => existsSync(path.join(dataDir, 'qqbot-requests.jsonl')) ? readFileSync(path.join(dataDir, 'qqbot-requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  async function waitFor(predicate) {
    for (let count = 0; count < 150; count++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('QQ Bot processing did not complete');
  }
  function event(id, group = false, content = 'https://m.tb.cn/h.test') {
    writeFileSync(path.join(dataDir, 'pending-event.json'), JSON.stringify({ op: 0, t: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', d: {
      id, group_openid: group ? 'group-openid' : undefined,
      author: group ? { member_openid: 'member-openid' } : { user_openid: 'private-openid' }, content
    } }));
    renameSync(path.join(dataDir, 'pending-event.json'), path.join(dataDir, 'qqbot-event.json'));
  }
  try {
    await waitFor(async () => { try { await fetch(base + '/api/bootstrap'); return true; } catch { return false; } });
    await request('/api/setup', 'POST', { username: 'admin', password: 'long-test-password' });
    await request('/api/rebates', 'PUT', { platform: 'taobao', provider: 'zhetaoke', ztkAppKey: 'tb-key', ztkSid: 'tb-sid', ztkPid: 'mm_111_222_333', ztkRelationId: '456', ztkTaobaoSignurl: '5' });
    await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true, image: true });
    await request('/api/qqbot', 'PUT', { enabled: true, appId: '123', appSecret: 'mock-secret' });
    for (const [id, group] of [['private-time', false], ['group-time', true]]) {
      event(id, group, ' time ');
      await waitFor(() => calls().some(call => call.body.msg_id === id));
      const sent = calls().find(call => call.body.msg_id === id);
      assert.equal(sent.body.msg_type, 0);
      assert.match(sent.body.content, /^当前时间：.*北京时间（UTC\+8）$/s);
      assert.equal(sent.body.msg_seq, 1);
    }
    for (const [id, group] of [['private-1', false], ['group-1', true]]) {
      event(id, group);
      await waitFor(() => calls().some(call => call.body.msg_id === id));
      const sent = calls().find(call => call.body.msg_id === id);
      assert.equal(sent.url, `https://api.sgroup.qq.com/v2/${group ? 'groups/group-openid' : 'users/private-openid'}/messages`);
      assert.equal(sent.body.msg_type, 7);
      assert.deepEqual(sent.body.media, { file_info: group ? 'group-media' : 'private-media' });
      assert.match(sent.body.content, /https:\/\/s.click.taobao.com\/share-test/);
      assert.equal(sent.body.msg_seq, 1);
    }
    await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true, image: false });
    const uploads = calls().filter(call => call.url.endsWith('/files')).length;
    event('without-image');
    await waitFor(() => calls().some(call => call.body.msg_id === 'without-image'));
    assert.equal(calls().find(call => call.body.msg_id === 'without-image').body.msg_type, 0);
    assert.equal(calls().filter(call => call.url.endsWith('/files')).length, uploads);
    await request('/api/rebates/automation', 'PUT', { enabled: true, reply: true, image: true });
    writeFileSync(path.join(dataDir, 'fail-upload'), '1');
    event('upload-failed', true);
    await waitFor(() => calls().some(call => call.body.msg_id === 'upload-failed'));
    assert.equal(calls().find(call => call.body.msg_id === 'upload-failed').body.msg_type, 0);
    await waitFor(async () => (await request('/api/logs')).logs.some(log => log.area === 'qqbot' && /上传失败.*304082/.test(log.message)));
    assert.match((await request('/api/qqbot')).lastError, /304082/);
    event('group-1', true);
    await waitFor(() => !existsSync(path.join(dataDir, 'qqbot-event.json')));
    assert.equal(calls().filter(call => call.body.msg_id === 'group-1').length, 1);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
