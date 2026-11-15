import { spawnSync } from 'node:child_process';

// Only used for the disposable, unsigned-in CI container. Do not dump QR URLs,
// credentials, or management tokens into public Actions logs.
const container = process.argv[2] || 'xiaomizhou-qq-smoke';
if (!/^[a-zA-Z0-9_.-]+$/.test(container)) throw new Error('Invalid diagnostic container');
const script = `
  const fs = require('fs'); const path = require('path');
  const root = '/app/data';
  try { console.log('QQ process state:', fs.readFileSync(path.join(root, 'napcat-runtime.json'), 'utf8')); } catch {}
  const dir = path.join(root, 'napcat/logs');
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir, {recursive:true}).filter(n=>n.endsWith('.log')).slice(-5)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).size > 1024 * 1024) continue;
    console.log('NapCat diagnostic log:', name);
    console.log(fs.readFileSync(file, 'utf8').split('\\n').filter(line=>!/token|credential|secret|qrcode|二维码|qr_code|https?:\\/\\//i.test(line)).slice(-60).join('\\n'));
  }
`;
const result = spawnSync('docker', ['exec', container, 'node', '-e', script], { encoding: 'utf8', timeout: 15000 });
console.log(result.stdout || 'No runtime diagnostics available');
