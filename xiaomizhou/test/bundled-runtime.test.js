import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareBundledRuntime, createRuntimeSupervisor, bundledRuntimeStatus } from '../bundled-runtime.js';

const waitUntil = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('runtime condition did not become true');
};

test('complete runtime refuses missing payloads and prepares persistent local-only configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomizhou-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime'); const qqDir = path.join(root, 'QQ'); const dataDir = path.join(root, 'data');
  assert.throws(() => prepareBundledRuntime({ runtimeDir, qqDir, dataDir, appPort: 8090 }), /运行文件缺失/);
  for (const file of [path.join(runtimeDir, 'napcat.mjs'), path.join(runtimeDir, 'node_modules/express/package.json'), path.join(qqDir, 'qq'), path.join(qqDir, 'resources/app/package.json'), path.join(qqDir, 'resources/app/wrapper.node')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
  }
  const first = prepareBundledRuntime({ runtimeDir, qqDir, dataDir, appPort: 8090 });
  assert.equal(first.env.NAPCAT_BUNDLED, '1');
  assert.equal(first.env.NAPCAT_WEBUI_URL, 'http://127.0.0.1:6099');
  assert.equal(first.env.NAPCAT_CALLBACK_BASE_URL, 'http://127.0.0.1:8090');
  assert.match(first.env.NAPCAT_WEBUI_TOKEN, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(first.args).includes(first.env.NAPCAT_WEBUI_TOKEN));
  const configFile = path.join(dataDir, 'napcat/config/webui.json');
  const config = JSON.parse(fs.readFileSync(configFile));
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 6099);
  config.autoLoginAccount = '12345'; fs.writeFileSync(configFile, JSON.stringify(config));
  const second = prepareBundledRuntime({ runtimeDir, qqDir, dataDir, appPort: 8091 });
  assert.equal(first.env.NAPCAT_WEBUI_TOKEN, second.env.NAPCAT_WEBUI_TOKEN);
  assert.equal(second.env.NAPCAT_CALLBACK_BASE_URL, 'http://127.0.0.1:8091');
  assert.equal(JSON.parse(fs.readFileSync(configFile)).autoLoginAccount, '12345');
  assert.deepEqual(second.args.slice(-2), ['-q', '12345']);
  assert.ok(fs.existsSync(path.join(dataDir, 'napcat/config/onebot11.json')));
  fs.writeFileSync(path.join(dataDir, 'napcat-private.json'), 'broken');
  assert.throws(() => prepareBundledRuntime({ runtimeDir, qqDir, dataDir, appPort: 8090 }), /密钥文件损坏/);
});

test('supervisor starts a real child, restarts it and reaps it on shutdown', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomizhou-supervisor-'));
  const marker = path.join(root, 'starts.txt'); const statusFile = path.join(root, 'status.json');
  const fixture = path.join(root, 'child.cjs');
  fs.writeFileSync(fixture, "require('fs').appendFileSync(process.argv[2],process.pid+'\\n');setInterval(()=>{},1000)");
  const supervisor = createRuntimeSupervisor({ command: process.execPath, args: [fixture, marker], childEnv: process.env, statusFile, stopTimeout: 1000 });
  t.after(async () => { await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  supervisor.start();
  await waitUntil(() => fs.existsSync(marker));
  const firstPid = supervisor.status().pid;
  assert.equal(bundledRuntimeStatus(statusFile).state, 'running');
  await supervisor.restart();
  await waitUntil(() => fs.readFileSync(marker, 'utf8').trim().split('\n').length === 2);
  assert.notEqual(supervisor.status().pid, firstPid);
  assert.throws(() => process.kill(firstPid, 0), /ESRCH|no such process/i);
  const secondPid = supervisor.status().pid;
  await supervisor.stop();
  assert.equal(supervisor.status().state, 'stopped');
  assert.throws(() => process.kill(secondPid, 0), /ESRCH|no such process/i);
});

test('supervisor limits repeated crashes instead of looping indefinitely', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomizhou-crash-'));
  const supervisor = createRuntimeSupervisor({ command: process.execPath, args: ['-e', 'process.exit(7)'], childEnv: process.env, statusFile: path.join(root, 'status.json'), restartDelay: 10, stopTimeout: 1000 });
  t.after(async () => { await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  supervisor.start();
  await waitUntil(() => supervisor.status().state === 'failed');
  assert.equal(supervisor.status().restarts, 4);
  assert.match(supervisor.status().error, /连续退出/);
});
