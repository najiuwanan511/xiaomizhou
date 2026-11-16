import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Run only against a new disposable container before publishing its image.
const base = process.argv[2] || 'http://127.0.0.1:18090';
const framework = process.argv[3] || 'snowcat';
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
const credentials = { username: 'image-smoke-check', password: crypto.randomBytes(24).toString('hex') };
await request('/api/setup', credentials);
const config = await request('/api/napcat');
if (!config.bundled || config.webuiToken) throw new Error('Image is not in bundled mode');
if ((config.framework || 'napcat') !== framework) throw new Error('Image started a different QQ framework');
let usable = false;
for (let i = 0; i < 90; i++) {
  const status = await request('/api/napcat/status');
  if (status.state === 'auth-error') throw new Error(`QQ management authentication failed: ${status.error}`);
  if (status.runtime?.state === 'failed') throw new Error('QQ/SnowCat process failed to start');
  if (status.reachable && status.state === 'waiting' && /^data:image\/png;base64,/.test(status.qrCode || '')) { usable = true; break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!usable) throw new Error('Real bundled QQ did not produce a login QR code');
console.log(`Bundled image started the real QQ/${framework} runtime and produced a login QR code. No account was logged in.`);

// These checks inspect the actual container, not only its reported status.
const container = process.argv[4] || 'xiaomizhou-qq-smoke';
if (!/^[a-zA-Z0-9_.-]+$/.test(container)) throw new Error('Invalid smoke container');
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error('Container process check failed: ' + (result.stderr || result.error?.message));
  return result.stdout;
}
docker('exec', container, 'node', '-e', `const fs=require('fs');if(fs.existsSync('/opt/xiaomizhou-napcat')||fs.existsSync('/app/NapCat.Shell.zip'))throw Error('NapCat still shipped');if(!fs.existsSync('/opt/xiaomizhou-snowcat/napcat.mjs'))throw Error('SnowCat missing');`);
assert.equal(config.runtimeControl, true);
async function requireStopped() {
  const stopped = await request('/api/napcat/status');
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.runtime.enabled, false); assert.equal(stopped.runtime.state, 'stopped');
  assert.equal(stopped.qrCode, null); assert.equal(stopped.account, null);
  assert.equal((await request('/api/qq')).enabled, false);
  docker('exec', container, 'node', '-e', `
    const fs=require('fs');const net=require('net');
    for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))) {
      let args; try { args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0'); } catch { continue; }
      if(args[0]==='/opt/QQ/qq'||/^(?:.*\\/)?Xvfb$/.test(args[0]||''))throw Error('QQ/Xvfb process still alive');
    }
    Promise.all([3000,6099].map(port=>new Promise((resolve,reject)=>{
      const socket=net.connect(port,'127.0.0.1');socket.setTimeout(2000);
      socket.on('connect',()=>{socket.destroy();reject(Error('QQ port still open'));});
      socket.on('error',()=>resolve());socket.on('timeout',()=>{socket.destroy();reject(Error('Port check timed out'));});
    }))).catch(error=>{console.error(error.message);process.exitCode=1;});
  `);
}
await request('/api/napcat/stop', {});
await requireStopped();
console.log('Manual stop ended real QQ/Xvfb processes and closed both QQ ports.');
docker('restart', container);
ready = false;
for (let i=0;i<60;i++) {
  try { await request('/api/bootstrap'); ready=true; break; } catch { await new Promise(resolve=>setTimeout(resolve,1000)); }
}
assert.equal(ready,true);
await request('/api/login', credentials);
await requireStopped();
console.log('Container restart preserved the disabled kernel preference.');
await request('/api/napcat/start', {});
usable = false;
for (let i=0;i<90;i++) {
  const status=await request('/api/napcat/status');
  if(status.state==='auth-error'||status.runtime?.state==='failed')throw Error('Kernel restart failed');
  if(status.state==='waiting'&&/^data:image\/png;base64,/.test(status.qrCode||'')){usable=true;break;}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.equal(usable,true,'Starting a stopped kernel must regenerate a real QR');
await request('/api/napcat/stop', {}); await requireStopped();
console.log('Start restored real QR login; final stop released the kernel again.');
