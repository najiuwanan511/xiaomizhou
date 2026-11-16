import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { qqFramework } from './napcat-manager.js';

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(temporary, file);
}

// Run once in the image's parent launcher. Secrets never enter the browser or
// container command line, and remain stable across upgrades and restarts.
export function prepareBundledRuntime({ dataDir, appPort, framework = 'snowcat', runtimeDir = '/opt/xiaomizhou-snowcat', qqDir = '/opt/QQ' }) {
  qqFramework(framework);
  for (const file of [path.join(runtimeDir, 'napcat.mjs'), path.join(runtimeDir, 'node_modules/express/package.json'), path.join(qqDir, 'qq'), path.join(qqDir, 'resources/app/package.json'), path.join(qqDir, 'resources/app/wrapper.node')]) {
    if (!fs.existsSync(file)) throw new Error(`内置 QQ 运行文件缺失：${file}。请重新构建完整小米粥镜像`);
  }
  const privateFile = path.join(dataDir, `${framework}-private.json`);
  let secrets;
  try { secrets = JSON.parse(fs.readFileSync(privateFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('内置 QQ 密钥文件损坏，请恢复数据备份');
    secrets = { webuiToken: crypto.randomBytes(32).toString('hex') };
    writeJson(privateFile, secrets);
  }
  if (!/^[a-f0-9]{64}$/.test(secrets.webuiToken || '')) throw new Error('内置 QQ 密钥格式无效，请恢复数据备份');
  // The official SnowCat v6.0.0 supports a strong signing key through env;
  // supply it explicitly so its Math.random fallback is never used.
  if (framework === 'snowcat') {
    if (!secrets.jwtKey) { secrets.jwtKey = crypto.randomBytes(32).toString('hex'); writeJson(privateFile, secrets); }
    if (!/^[a-f0-9]{64}$/.test(secrets.jwtKey)) throw new Error('SnowCat 签名密钥格式无效，请恢复数据备份');
  }
  const workdir = path.join(dataDir, framework);
  const home = path.join(dataDir, 'snowcat-qq-home');
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const configFile = path.join(workdir, 'config/webui.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('内置 QQ 管理配置损坏，请恢复数据备份'); }
  writeJson(configFile, { ...existing, host: '127.0.0.1', port: 6099, token: secrets.webuiToken, disableWebUI: false });
  const onebotFile = path.join(workdir, 'config/onebot11.json');
  if (!fs.existsSync(onebotFile)) writeJson(onebotFile, { network: { httpServers: [], httpSseServers: [], httpClients: [], websocketServers: [], websocketClients: [], plugins: [] } });
  const coreDefaults = path.join(runtimeDir, 'defaults/napcat.json');
  const coreConfig = path.join(workdir, 'config/napcat.json');
  if (fs.existsSync(coreDefaults) && !fs.existsSync(coreConfig)) {
    const defaults = JSON.parse(fs.readFileSync(coreDefaults, 'utf8'));
    writeJson(coreConfig, { ...defaults, fileLog: true, consoleLog: false });
  }
  const shippedPlugins = path.join(runtimeDir, 'plugins');
  const plugins = path.join(workdir, 'plugins');
  if (fs.existsSync(shippedPlugins) && !fs.existsSync(plugins)) fs.cpSync(shippedPlugins, plugins, { recursive: true });
  const statusFile = path.join(dataDir, `${framework}-runtime.json`);
  const env = {
    QQ_FRAMEWORK: framework, QQ_KERNEL_CONTROL: '1',
    NAPCAT_BUNDLED: '1', NAPCAT_WEBUI_URL: 'http://127.0.0.1:6099',
    NAPCAT_WEBUI_TOKEN: secrets.webuiToken, NAPCAT_ONEBOT_URL: 'http://127.0.0.1:3000',
    NAPCAT_CALLBACK_BASE_URL: `http://127.0.0.1:${appPort}`, NAPCAT_STATUS_FILE: statusFile
  };
  const childEnv = {
    ...process.env, QQ_FRAMEWORK: framework, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    NAPCAT_WORKDIR: workdir, NAPCAT_WEBUI_SECRET_KEY: secrets.webuiToken,
    ...(framework === 'snowcat' ? { NAPCAT_WEBUI_JWT_SECRET_KEY: secrets.jwtKey } : {}),
    NAPCAT_WEBUI_PREFERRED_PORT: '6099', NAPCAT_DISABLE_PIPE: '1',
    NAPCAT_DISABLE_MULTI_PROCESS: '1', NAPCAT_QQ_PACKAGE_INFO_PATH: path.join(qqDir, 'resources/app/package.json'),
    NAPCAT_WRAPPER_PATH: path.join(qqDir, 'resources/app/wrapper.node'),
    XIAOMIZHOU_NAPCAT_ENTRY: path.join(runtimeDir, 'napcat.mjs')
  };
  const quickLogin = /^\d+$/.test(String(existing.autoLoginAccount || '')) ? ['-q', String(existing.autoLoginAccount)] : [];
  return { env, childEnv, statusFile, command: 'xvfb-run', args: ['-a', '-s', '-screen 0 1280x720x24', path.join(qqDir, 'qq'), '--no-sandbox', '--disable-dev-shm-usage', ...quickLogin] };
}

// One supervisor owns the complete QQ/NapCat process group. Updating only the
// web backend leaves the QQ session alive; container shutdown ends both.
export function createRuntimeSupervisor({ command, args, childEnv, statusFile, spawnChild = spawn, restartDelay = 3000, stopTimeout = 7000 }) {
  let child = null;
  let timer = null;
  let stopping = false;
  let failures = [];
  let state = { state: 'stopped', pid: null, restarts: 0, error: null, changedAt: new Date().toISOString() };
  const publish = update => { state = { ...state, ...update, changedAt: new Date().toISOString() }; writeJson(statusFile, state, 0o600); };
  const signal = (target, name) => {
    try { if (process.platform !== 'win32' && target.pid) process.kill(-target.pid, name); else target.kill(name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const start = () => {
    if (child || stopping) return;
    clearTimeout(timer);
    publish({ state: 'starting', error: null });
    const current = spawnChild(command, args, { env: childEnv, stdio: 'ignore', detached: process.platform !== 'win32' });
    child = current;
    // Upstream stdout can contain the management token and login QR payload.
    // Keep it out of shared Docker logs; NapCat maintains its own logs in data/.
    current.once('spawn', () => publish({ state: 'running', pid: current.pid }));
    current.once('error', () => publish({ state: 'failed', pid: null, error: 'QQ 内核进程启动失败，请检查镜像中的运行依赖' }));
    current.once('close', (code, exitSignal) => {
      if (child !== current) return;
      child = null;
      // xvfb-run is the group leader; also reap any remaining QQ descendants.
      signal(current, 'SIGKILL');
      if (stopping) { publish({ state: 'stopped', pid: null }); return; }
      failures = failures.filter(time => Date.now() - time < 60000);
      failures.push(Date.now());
      if (failures.length >= 5) { publish({ state: 'failed', pid: null, error: 'QQ 内核连续退出，已暂停重启；请检查 data/snowcat/logs 后点击重启内核' }); return; }
      publish({ state: 'restarting', pid: null, restarts: state.restarts + 1, error: `QQ 内核退出（${code ?? exitSignal ?? 'unknown'}），正在重新启动` });
      timer = setTimeout(start, restartDelay);
    });
  };
  const stop = async () => {
    stopping = true; clearTimeout(timer);
    const current = child;
    if (current) {
      publish({ state: 'stopping' });
      const closed = once(current, 'close').catch(() => {});
      signal(current, 'SIGTERM');
      const force = setTimeout(() => signal(current, 'SIGKILL'), stopTimeout);
      try { await closed; } finally { clearTimeout(force); }
    }
    publish({ state: 'stopped', pid: null });
  };
  const restart = async () => { await stop(); failures = []; stopping = false; start(); };
  return { start, stop, restart, status: () => ({ ...state }) };
}

export function bundledRuntimeStatus(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { state: value.state, enabled: kernelEnabled(path.dirname(file)), restarts: value.restarts, error: value.error, changedAt: value.changedAt };
  } catch { return { state: 'unavailable', error: '无法读取内置 QQ 内核状态' }; }
}

export function kernelEnabled(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'qq-kernel-control.json'), 'utf8'));
    if (typeof state.enabled !== 'boolean') throw new Error('Invalid kernel preference');
    return state.enabled;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw new Error('QQ 内核启停设置损坏，请恢复数据备份');
  }
}

// User stop is durable; application/container shutdown does not change it.
// Only one action owns the process group, including while stop is awaiting exit.
export function createKernelController({ dataDir, createSupervisor }) {
  let enabled = kernelEnabled(dataDir), supervisor, busy = false, closed = false, pending;
  const save = value => { writeJson(path.join(dataDir, 'qq-kernel-control.json'), { enabled: value }); enabled = value; };
  const start = () => { supervisor = createSupervisor(); supervisor.start(); };
  async function initialize() {
    supervisor = createSupervisor();
    if (enabled) supervisor.start(); else await supervisor.stop();
  }
  async function run(action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw Object.assign(new Error('无效的内核操作'), { status: 400 });
    if (closed || busy) throw Object.assign(new Error('内核正在处理其他操作，请稍后重试'), { status: 409 });
    if (action === 'restart' && !enabled) throw Object.assign(new Error('内核已停止，请点击启动内核'), { status: 409 });
    busy = true;
    pending = (async () => {
      if (action === 'stop') { save(false); await supervisor?.stop(); }
      else if (action !== 'start' || !enabled || ['failed', 'stopped'].includes(supervisor?.status().state)) {
        save(true); await supervisor?.stop(); if (!closed) start();
      }
      return { ok: true, enabled };
    })();
    try { return await pending; } finally { busy = false; }
  }
  async function shutdown() { closed = true; await pending?.catch(() => {}); await supervisor?.stop(); }
  return { initialize, run, shutdown, status: () => ({ enabled, busy, ...supervisor?.status() }) };
}
