import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import './affiliate-fetch-mock.fixture.js';

const originalFetch = globalThis.fetch;
const dataDir = process.env.DATA_DIR;
const commands = path.join(dataDir, 'qqbot-event.json');
const requests = path.join(dataDir, 'qqbot-requests.jsonl');
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url === 'https://bots.qq.com/app/getAppAccessToken') return Response.json({ access_token: 'mock-qq-token', expires_in: '7200' });
  if (url === 'https://api.sgroup.qq.com/gateway') return Response.json({ url: 'wss://api.bot.qq.com/test' });
  if (url.startsWith('https://api.sgroup.qq.com/v2/')) {
    assert.equal(options.headers.Authorization, 'QQBot mock-qq-token');
    const body = JSON.parse(options.body);
    fs.appendFileSync(requests, JSON.stringify({ url, body }) + '\n');
    if (url.endsWith('/files')) {
      assert.equal(body.url, 'https://img.alicdn.com/item.jpg');
      assert.equal(body.srv_send_msg, false);
      if (fs.existsSync(path.join(dataDir, 'fail-upload'))) return Response.json({ code: 304082, message: 'upload media info fail' }, { status: 400 });
      return Response.json({ file_info: url.includes('/groups/') ? 'group-media' : 'private-media' });
    }
    return Response.json({ id: 'mock-sent' });
  }
  return originalFetch(input, options);
};

globalThis.WebSocket = class {
  readyState = 1;
  listeners = new Map();
  busy = false;
  constructor() {
    this.timer = setInterval(async () => {
      if (this.busy || !fs.existsSync(commands)) return;
      this.busy = true;
      try {
        const event = JSON.parse(fs.readFileSync(commands, 'utf8'));
        fs.unlinkSync(commands);
        await this.listeners.get('message')?.({ data: JSON.stringify(event) });
      } finally { this.busy = false; }
    }, 10);
  }
  addEventListener(type, callback) {
    this.listeners.set(type, callback);
    if (type === 'message') queueMicrotask(() => callback({ data: JSON.stringify({ op: 0, t: 'READY', d: {} }) }));
  }
  send() {}
  close() { clearInterval(this.timer); this.readyState = 3; this.listeners.get('close')?.(); }
};
