import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './update-manager.js';
import { prepareBundledRuntime, createRuntimeSupervisor, createKernelController } from './bundled-runtime.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const releases = path.join(dataDir, 'releases');
const pointer = path.join(releases, 'current.json');
const baseVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const port = Number(process.env.PORT || 8090);
let qqKernel = null;
let shuttingDown = false;
if (process.env.NAPCAT_BUNDLED === '1') {
  if (process.platform !== 'linux') throw new Error('完整内置 QQ 镜像需要 Linux 运行环境');
  Object.assign(process.env, prepareBundledRuntime({ dataDir, appPort: port }).env);
  qqKernel = createKernelController({ dataDir, createSupervisor: () => createRuntimeSupervisor(prepareBundledRuntime({ dataDir, appPort: port })) });
  await qqKernel.initialize();
}

function selected() {
  try {
    const state = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    if (!/^\d+\.\d+\.\d+$/.test(state.version) || compareVersions(state.version, baseVersion) <= 0) return { dir: root, state: null };
    const dir = path.join(releases, `v${state.version}`);
    if (!fs.existsSync(path.join(dir, 'server.js'))) throw new Error('Installed release is incomplete');
    return { dir, state };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Update selection failed: ${error.message}`);
    return { dir: root, state: null };
  }
}

async function healthy(child) {
  for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch { /* Wait for the listener. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function launch() {
  const { dir, state } = selected();
  if (dir !== root && !fs.existsSync(path.join(dir, 'node_modules'))) {
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, XIAOMIZHOU_MANAGED: '1' }
  });
  const onSignal = signal => { shuttingDown = true; child.kill(signal); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  let restart = false;
  child.on('message', message => { if (message?.type === 'update-installed') restart = true; });
  child.on('message', message => {
    if (message?.type === 'qq-kernel-control') {
      const reply = result => { if (child.connected) child.send({ type: 'qq-kernel-result', id: message.id, ...result }); };
      if (!qqKernel || shuttingDown) return reply({ ok: false, status: 409, error: '内核控制器不可用' });
      void qqKernel.run(message.action).then(reply, error => reply({ ok: false, status: error.status || 500, error: error.status ? error.message : '内核操作失败，请查看容器日志' }));
    }
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (state?.pending) {
    if (await healthy(child)) {
      fs.writeFileSync(pointer, JSON.stringify({ version: state.version }));
    } else {
      console.error(`Release v${state.version} did not start; restoring previous version`);
      child.kill();
      await exit;
      if (state.previousVersion && compareVersions(state.previousVersion, baseVersion) > 0) fs.writeFileSync(pointer, JSON.stringify({ version: state.previousVersion }));
      else fs.rmSync(pointer, { force: true });
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      return launch();
    }
  }
  const result = await exit;
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
  if (restart) return launch();
  await qqKernel?.shutdown();
  process.exit(result.code || (result.signal ? 1 : 0));
}

launch().catch(async error => { console.error(error); await qqKernel?.shutdown(); process.exit(1); });
