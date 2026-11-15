import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import { compareVersions } from './update-manager.js';

const lock = JSON.parse(fs.readFileSync(new URL('./napcat-runtime.lock.json', import.meta.url)));
const maxDownload = 150 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+$/;
export const napcatUpdateRepo = lock.repository;
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Extract only regular files into a new, private staging directory. Never follow
// archive links, overwrite duplicate entries, or allow writes outside the stage.
export async function extractNapcatZip(file, destination) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  let count = 0, total = 0;
  const seen = new Set();
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        void (async () => {
          const name = entry.fileName;
          const parts = name.replace(/\/$/, '').split('/');
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (++count > 20000 || !name || name.includes('\\') || parts.some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p)) || name.startsWith('/') || (type && ![0x4000, 0x8000].includes(type)) || (entry.generalPurposeBitFlag & 1)) throw new Error('升级包包含不安全的 ZIP 路径或文件类型');
          const key = name.replace(/\/$/, '').toLowerCase();
          if (seen.has(key)) throw new Error('升级包包含重复路径');
          seen.add(key);
          total += entry.uncompressedSize;
          if (total > 800 * 1024 * 1024) throw new Error('升级包解压大小超过限制');
          const target = path.resolve(destination, ...parts);
          if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('升级包路径越界');
          if (name.endsWith('/')) fs.mkdirSync(target, { recursive: true });
          else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const input = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
            await pipeline(input, fs.createWriteStream(target, { flags: 'wx', mode: (entry.externalFileAttributes >>> 16) & 0o111 ? 0o755 : 0o644 }));
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

export function validateNapcatPayload(dir, arch = process.arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('当前架构不支持 NapCat 内核在线更新');
  for (const name of ['napcat.mjs', 'package.json', 'node_modules/express/package.json', 'node_modules/ws/package.json', `native/packet/MoeHoo.linux.${arch}.node`, 'static/index.html']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size) throw new Error(`NapCat 升级包不完整：${name}`);
  }
}

export function readNapcatUpdateStatus(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'napcat-releases/status.json'), 'utf8')); }
  catch { return { state: 'unavailable', currentVersion: lock.version, message: '内核更新管理器尚未就绪', canRollback: false }; }
}

export function createNapcatUpdater({ dataDir, baseDir = '/opt/xiaomizhou-napcat', baseVersion = lock.version, arch = process.arch, fetcher = fetch, stopRuntime, startRuntime, healthy }) {
  const releases = path.join(dataDir, 'napcat-releases');
  const pointer = path.join(releases, 'current.json');
  const statusFile = path.join(releases, 'status.json');
  const configDir = path.join(dataDir, 'napcat/config');
  fs.mkdirSync(releases, { recursive: true });
  let busy = false;
  let candidate = null;
  let state = {};
  const readPointer = () => {
    try {
      const value = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      if (value.baseVersion !== baseVersion || value.arch !== arch) return null;
      if (!versionPattern.test(value.version) || (value.previous && !versionPattern.test(value.previous)) || (value.backup && !/^backup-[a-f0-9-]{36}$/.test(value.backup))) throw new Error('内核版本记录损坏');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const directory = version => version === baseVersion ? baseDir : path.join(releases, `v${version}`);
  const currentVersion = () => readPointer()?.version || baseVersion;
  const publish = patch => {
    state = { ...state, ...patch, currentVersion: currentVersion(), canRollback: !!readPointer()?.previous, repository: napcatUpdateRepo, changedAt: new Date().toISOString() };
    atomicJson(statusFile, state);
    return state;
  };
  const saveConfig = backup => {
    const target = path.join(releases, backup);
    fs.mkdirSync(target);
    if (fs.existsSync(configDir)) fs.cpSync(configDir, path.join(target, 'config'), { recursive: true });
  };
  const restoreConfig = backup => {
    const source = path.join(releases, backup, 'config');
    if (!fs.existsSync(source)) throw new Error('缺少升级前的配置备份');
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.cpSync(source, configDir, { recursive: true });
  };
  const restorePointer = previous => previous ? atomicJson(pointer, previous) : fs.rmSync(pointer, { force: true });
  // An interrupted installation is never treated as a confirmed healthy release.
  const interrupted = readPointer();
  if (interrupted?.pending) {
    restoreConfig(interrupted.backup);
    atomicJson(pointer, { version: interrupted.previous, baseVersion, arch });
    publish({ state: 'rolled-back', message: '上次内核升级中断，已恢复升级前的内核与配置' });
  } else publish({ state: 'idle', message: '可以检查 NapCat 更新' });

  async function releaseInfo() {
    let response;
    try {
      response = await fetcher(`https://api.github.com/repos/${napcatUpdateRepo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xiaomizhou-napcat-updater' }, signal: AbortSignal.timeout(20000) });
    } catch { throw new Error('无法连接 NapCat 更新源，请检查设备访问 GitHub 的网络后重试'); }
    if (!response.ok) throw new Error(`检查 NapCat 更新失败：HTTP ${response.status}`);
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('更新元数据过大'); chunks.push(chunk); }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name || '')?.[1];
    if (!version || release.draft || release.prerelease) throw new Error('暂无可用稳定版 NapCat');
    const asset = release.assets?.find(a => a.name === 'NapCat.Shell.zip');
    const url = `https://github.com/${napcatUpdateRepo}/releases/download/v${version}/NapCat.Shell.zip`;
    const sha256 = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest || '')?.[1];
    if (!sha256 || asset?.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxDownload) throw new Error('发行包缺少有效的 SHA-256 或下载信息，已拒绝安装');
    const available = compareVersions(version, currentVersion()) > 0;
    const compatible = version.split('.')[0] === baseVersion.split('.')[0];
    return { version, url, sha256, size: asset.size, available, compatible, releaseUrl: `https://github.com/${napcatUpdateRepo}/releases/tag/v${version}` };
  }
  const check = async () => {
    candidate = await releaseInfo();
    return publish({ state: 'checked', latestVersion: candidate.version, available: candidate.available, compatible: candidate.compatible, releaseUrl: candidate.releaseUrl, message: candidate.available ? candidate.compatible ? '发现新版本，可在线升级；启动不兼容时自动回滚' : '此版本需升级完整小米粥镜像，以更新配套 QQ 环境' : '当前已是最新版本' });
  };
  async function install(expectedVersion) {
    const info = await releaseInfo();
    if (!expectedVersion || expectedVersion !== info.version) throw new Error('版本信息已变化，请重新检查更新');
    if (!info.available) throw new Error('当前已是最新版本');
    if (!info.compatible) throw new Error('跨大版本更新需要升级完整小米粥镜像');
    const stage = fs.mkdtempSync(path.join(releases, '.stage-'));
    const zipFile = path.join(stage, 'payload.zip');
    const payload = path.join(stage, 'runtime');
    const previous = readPointer();
    const previousVersion = currentVersion();
    let switched = false;
    let stopped = false;
    let backup;
    try {
      publish({ state: 'downloading', progress: 0, message: '正在下载并校验 NapCat 发行包' });
      const response = await fetcher(info.url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`内核下载失败：HTTP ${response.status}`);
      const hash = crypto.createHash('sha256'); let size = 0; let lastProgress = -1;
      const output = fs.createWriteStream(zipFile, { flags: 'wx', mode: 0o600 });
      await pipeline(response.body, new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > info.size) return callback(new Error('升级包大小不符'));
        hash.update(chunk);
        const progress = Math.floor(size * 100 / info.size);
        if (progress >= lastProgress + 5) { lastProgress = progress; publish({ progress }); }
        callback(null, chunk);
      } }), output);
      if (size !== info.size || hash.digest('hex') !== info.sha256) throw new Error('NapCat 升级包 SHA-256 校验失败');
      publish({ state: 'extracting', message: '正在检查完整内核和架构' });
      fs.mkdirSync(payload);
      await extractNapcatZip(zipFile, payload);
      validateNapcatPayload(payload, arch);
      const destination = directory(info.version);
      // Only a previously failed, inactive installation can occupy this path.
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(payload, destination);
      publish({ state: 'switching', message: '正在重启 QQ 内核并验证启动；消息收发暂时中断' });
      await stopRuntime();
      stopped = true;
      backup = `backup-${crypto.randomUUID()}`;
      saveConfig(backup);
      switched = true;
      atomicJson(pointer, { version: info.version, previous: previousVersion, backup, baseVersion, arch, pending: true });
      await startRuntime(destination);
      if (!await healthy()) throw new Error('新内核未通过 QQ 登录接口启动检查');
      atomicJson(pointer, { version: info.version, previous: previousVersion, backup, baseVersion, arch });
      publish({ state: 'installed', available: false, progress: 100, message: 'NapCat 已升级，QQ 会话正在恢复；如提示扫码，请重新确认登录' });
    } catch (error) {
      if (switched) {
        await stopRuntime(); restoreConfig(backup); restorePointer(previous);
        await startRuntime(directory(previousVersion));
        const recovered = await healthy();
        publish({ state: 'rolled-back', message: `${error.message}；已恢复旧版${recovered ? '' : '，旧版启动检查也失败，请检查日志'}`, progress: null });
        return;
      }
      if (stopped) await startRuntime(directory(previousVersion));
      throw error;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  async function rollback() {
    const previous = readPointer();
    if (!previous?.previous || !previous.backup) throw new Error('没有可回滚的内核版本');
    validateNapcatPayload(directory(previous.previous), arch);
    publish({ state: 'switching', message: '正在恢复上一个内核与升级前配置' });
    await stopRuntime();
    const undo = `backup-${crypto.randomUUID()}`;
    try { saveConfig(undo); }
    catch (error) { await startRuntime(directory(previous.version)); throw error; }
    try {
      // Persist recovery intent before restoreConfig removes the live config.
      // A terminated launcher can then restore the pre-rollback core and backup.
      atomicJson(pointer, { version: previous.previous, previous: previous.version, backup: undo, baseVersion, arch, pending: true });
      restoreConfig(previous.backup);
      await startRuntime(directory(previous.previous));
      if (!await healthy()) throw new Error('旧内核未通过启动检查');
      atomicJson(pointer, { version: previous.previous, baseVersion, arch });
      publish({ state: 'rolled-back', available: false, message: '已恢复升级前的内核与配置' });
    } catch (error) {
      await stopRuntime(); restoreConfig(undo); restorePointer(previous);
      await startRuntime(directory(previous.version));
      throw error;
    }
  }
  return {
    selectedDirectory: () => directory(currentVersion()),
    isBusy: () => busy,
    async run(action, version) {
      if (busy) throw new Error('已有内核更新任务正在进行');
      busy = true;
      try {
        if (action === 'check') { publish({ state: 'checking', message: '正在检查 NapCat 更新' }); await check(); }
        else if (action === 'install') await install(version);
        else if (action === 'rollback') await rollback();
        else if (action === 'restart') {
          publish({ state: 'switching', message: '正在重启 QQ 内核' });
          await stopRuntime(); await startRuntime(directory(currentVersion()));
          publish({ state: 'idle', message: 'QQ 内核已重新启动，正在恢复会话' });
        }
        else throw new Error('未知内核更新操作');
      } catch (error) { publish({ state: 'error', message: error.message, progress: null }); }
      finally { busy = false; }
      return state;
    }
  };
}
