import crypto from 'node:crypto';

// Run only against a new disposable container before publishing its image.
const base = process.argv[2] || 'http://127.0.0.1:18090';
const framework = process.argv[3] || 'napcat';
let cookie = '';
async function request(url, payload) {
  const response = await fetch(base + url, { method: payload ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(15000) });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`Bundled smoke check failed: ${response.status}`);
  return data;
}
let ready = false;
for (let i = 0; i < 60; i++) {
  try { await request('/api/bootstrap'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
}
if (!ready) throw new Error('Complete image did not start');
await request('/api/setup', { username: 'image-smoke-check', password: crypto.randomBytes(24).toString('hex') });
const config = await request('/api/napcat');
if (!config.bundled || config.webuiToken) throw new Error('Image is not in bundled mode');
if ((config.framework || 'napcat') !== framework) throw new Error('Image started a different QQ framework');
let usable = false;
for (let i = 0; i < 90; i++) {
  const status = await request('/api/napcat/status');
  if (status.state === 'auth-error') throw new Error(`QQ management authentication failed: ${status.error}`);
  if (status.runtime?.state === 'failed') throw new Error('QQ/NapCat process failed to start');
  if (status.reachable && status.state === 'waiting' && /^data:image\/png;base64,/.test(status.qrCode || '')) { usable = true; break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!usable) throw new Error('Real bundled QQ did not produce a login QR code');
console.log(`Bundled image started the real QQ/${framework} runtime and produced a login QR code. No account was logged in.`);
