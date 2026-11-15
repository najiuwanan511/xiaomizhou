import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

async function server(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmz-auth-'));
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) }, stdio: 'ignore'
  });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/api/bootstrap'); return { dataDir, base }; }
    catch { await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  assert.fail('auth test server did not start');
}

test('concurrent first-time setup creates exactly one administrator and keeps its webhook token', async t => {
  const { base, dataDir } = await server(t);
  const pendingSetup = username => {
    const body = JSON.stringify({ username, password: 'local-regression-password' });
    let request;
    const result = new Promise((resolve, reject) => {
      request = http.request(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
      request.write(body.slice(0, 1));
    });
    t.after(() => request.destroy());
    return { finish: () => request.end(body.slice(1)), result };
  };
  const first = pendingSetup('first-admin'), second = pendingSetup('second-admin');
  // Both handlers receive headers and wait for their incomplete request bodies.
  await new Promise(resolve => setTimeout(resolve, 100));
  first.finish(); assert.equal(await first.result, 200);
  const db = new DatabaseSync(path.join(dataDir, 'ownman.db'));
  try {
    const token = db.prepare("SELECT value FROM settings WHERE key='webhookToken'").get().value;
    second.finish(); assert.equal(await second.result, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='webhookToken'").get().value, token);
  } finally { db.close(); }
});

test('logout revokes the current session on the server without revoking other signed-in sessions', async t => {
  const { base } = await server(t);
  const credentials = { username: 'admin', password: 'local-regression-password' };
  const login = endpoint => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  const setup = await login('/api/setup'); assert.equal(setup.status, 200);
  const firstCookie = setup.headers.get('set-cookie').split(';')[0];
  const otherLogin = await login('/api/login'); assert.equal(otherLogin.status, 200);
  const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
  const request = (endpoint, cookie, method = 'GET') => fetch(base + endpoint, { method, headers: { Cookie: cookie } });
  assert.equal((await request('/api/settings', firstCookie)).status, 200);
  assert.equal((await request('/api/logout', firstCookie, 'POST')).status, 200);
  assert.equal((await request('/api/settings', firstCookie)).status, 401);
  assert.equal((await request('/api/settings', otherCookie)).status, 200);
  assert.equal((await (await request('/api/bootstrap', firstCookie)).json()).authenticated, false);
});
