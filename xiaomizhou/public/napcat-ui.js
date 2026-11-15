export async function renderNapcat({ api, shell, heading, icon, escapeHtml, date, toast, active, reload }) {
  const [config, qq, settings] = await Promise.all([api('/napcat'), api('/qq'), api('/settings')]);
  if (!active()) return () => {};
  shell(`${heading('个人 QQ · NapCat', '扫码登录 QQ，查看在线状态并接通消息收发')}
    <div class="two-col napcat-panels">
      <section class="panel pad">
        <div class="section-head"><h2>QQ 扫码登录</h2><span class="pill off" id="napcat-state">正在检查</span></div>
        <div class="napcat-login">
          <div class="napcat-qr" id="napcat-qr"><img id="napcat-qr-image" hidden alt="使用手机 QQ 扫描此二维码登录" width="256" height="256"><div id="napcat-qr-empty">保存连接配置后显示二维码</div></div>
          <div id="napcat-account" class="napcat-account" hidden></div>
          <p id="napcat-hint" class="muted" role="status">正在读取 NapCat 状态…</p>
          <div class="row"><button class="btn" id="napcat-refresh" disabled>${icon('refresh-cw')} 刷新二维码</button><button class="btn primary" id="napcat-connect" ${config.bundled ? 'hidden' : ''} disabled>${icon('plug-zap')} 接通消息收发</button></div>
        </div>
        <div id="napcat-error" class="alert" role="alert" hidden></div>
        <div id="napcat-notice" class="notice" role="status" hidden></div>
        <dl class="napcat-status"><div><dt>NapCat 服务</dt><dd id="napcat-service">检查中</dd></div><div><dt>消息 API</dt><dd id="napcat-message">检查中</dd></div><div><dt>最近检查</dt><dd id="napcat-checked">—</dd></div><div><dt>最近收到消息</dt><dd id="napcat-event">${qq.lastEventAt ? escapeHtml(date(qq.lastEventAt)) : '暂无'}</dd></div></dl>
        <p class="help">${config.bundled ? '使用手机 QQ 扫码并确认登录，小米粥会自动接通消息。无需单独安装或配置 NapCat。' : '使用手机 QQ 扫码并确认登录，再点击「接通消息收发」。'}连接成功后即可使用插件、AI 回复和转发规则。</p>
      </section>
      ${config.bundled ? `<section class="panel pad" id="napcat-runtime-panel"><div class="section-head"><h2>内置 QQ 内核</h2><span class="pill" id="napcat-runtime-state">检查中</span></div><p class="muted">完整 QQ 运行环境和 NapCat 内核随小米粥镜像一起安装，由小米粥自动启动、连接和恢复。</p><div class="notice">直接扫描左侧二维码登录。连接地址、密钥和消息回调均由小米粥内部管理。</div><p class="help section">登录数据随小米粥数据目录持久保存。QQ 掉线且无法重新扫码时，可重启内核；现有插件和转发规则会保留。</p><button class="btn" id="napcat-restart">${icon('refresh-cw')} 重启 QQ 内核</button><hr><div class="section-head"><h2>NapCat 在线更新</h2><span class="pill" id="napcat-version">读取中</span></div><p id="napcat-update-status" class="muted" role="status">正在读取更新状态…</p><div class="row"><button class="btn" id="napcat-update-check">检查更新</button><button class="btn primary" id="napcat-update-install" hidden>升级 NapCat</button><button class="btn" id="napcat-update-rollback" hidden>回滚上一版</button></div><p class="help">升级会短暂中断 QQ 消息。下载校验后重启内核，启动检查失败自动恢复旧版与配置。跨大版本或配套 QQ 环境变化时需升级完整镜像。</p></section>` : ''}
      <section class="panel pad" ${config.bundled ? 'hidden' : ''}>
        <div class="section-head"><h2>NapCat 连接配置</h2></div>
        <p class="muted">NapCat 需随小米粥部署或已在其他设备运行。保存一次后，即可在本页扫码登录。</p>
        <form id="napcat-form">
          <div class="field"><label for="napcat-url">NapCat 管理地址</label><input id="napcat-url" type="url" value="${escapeHtml(config.webuiUrl)}" placeholder="http://napcat:6099" required><small>填写小米粥服务能访问的 NapCat WebUI 地址。</small></div>
          <div class="field"><label for="napcat-token">NapCat WebUI Token</label><input id="napcat-token" type="password" autocomplete="off" value="${escapeHtml(config.webuiToken)}" required><small>用于管理和扫码登录，与消息 API 的 Access Token 不同。</small></div>
          <div class="field"><label for="napcat-onebot">消息 API 地址</label><input id="napcat-onebot" type="url" value="${escapeHtml(config.onebotUrl)}" placeholder="http://napcat:3000"><small>自动接通时创建此端口的消息服务；留空使用管理地址的主机和 3000 端口。</small></div>
          <div class="field"><label for="napcat-callback">小米粥访问地址</label><input id="napcat-callback" type="url" value="${escapeHtml(config.callbackBaseUrl || location.origin)}" placeholder="http://xiaomizhou:8090" required><small>填写 NapCat 能访问的小米粥地址。同一套容器部署可用 http://xiaomizhou:8090。</small></div>
          <button class="btn primary" id="napcat-save" type="submit">${icon('save')} 保存并连接</button>
          <p class="muted" id="napcat-config-status" role="status">当前显示的是已保存配置</p>
        </form>
        <p class="help">「接通消息收发」会创建或更新小米粥专用的消息服务和回调，保留其他连接配置。无需再到 NapCat 页面复制回调地址。</p>
      </section>
    </div>
    <details class="panel pad section" id="qq-manual" ${config.bundled ? 'hidden' : ''}><summary>手动接入与排错</summary><div class="two-col section">
      <div><div class="field"><label for="qq-endpoint">HTTP API 地址</label><input id="qq-endpoint" value="${escapeHtml(qq.endpoint)}" placeholder="http://napcat:3000"></div><div class="field"><label for="qq-token">消息 API Access Token</label><input id="qq-token" type="password" autocomplete="off" value="${escapeHtml(qq.accessToken)}"></div><div class="field"><label class="switch"><input id="qq-enabled" type="checkbox" ${qq.enabled ? 'checked' : ''}> 启用消息接收</label></div><div class="row"><button class="btn" id="qq-save">保存手动配置</button><button class="btn" id="qq-test">测试消息连接</button></div><p id="qq-result" class="muted" role="status">${escapeHtml(qq.lastError || '已有 NapCat 消息服务可以在此手动接入')}</p></div>
      <div><div class="field"><label for="qq-callback">HTTP POST 回调地址</label><input id="qq-callback" class="mono" readonly value="${escapeHtml(`${config.callbackBaseUrl || location.origin}/api/qq/events?token=${settings.webhookToken}`)}"><small>包含接入令牌，请妥善保管。自动接通时会写入 NapCat。</small></div><p class="help">手动配置不影响已有转发规则。群转发目标填写 group:群号，私聊目标填写 private:QQ号。发送 time 或“时间”可测试回复。</p></div>
    </div></details>`);

  const element = id => document.getElementById(id);
  const panel = element('napcat-form');
  let alive = true;
  let timer;
  let busy = false;
  let dirty = false;
  let latest = null;
  let updateInfo = null;
  let updateBusy = false;
  let statusRevision = 0;
  let pollSequence = 0;
  const current = () => alive && active() && panel.isConnected;
  const notice = message => { element('napcat-notice').textContent = message; element('napcat-notice').hidden = !message; };
  const showError = message => { element('napcat-error').textContent = message || ''; element('napcat-error').hidden = !message; };
  function buttons() {
    element('napcat-save').disabled = busy;
    element('napcat-refresh').disabled = busy || dirty || !latest?.reachable || latest.state !== 'waiting';
    element('napcat-connect').disabled = busy || dirty || latest?.state !== 'online';
  }
  function display(data) {
    latest = data;
    if (!dirty) element('napcat-config-status').textContent = '当前显示的是已保存配置';
    const labels = { unconfigured: '待配置', online: 'QQ 在线', offline: 'QQ 已掉线', waiting: '等待扫码', 'auth-error': '鉴权失败', unreachable: '服务不可达' };
    const badge = element('napcat-state');
    if (config.bundled && data.runtime) {
      const runtimeLabels = { starting: '启动中', running: '运行中', restarting: '重启中', stopped: '已停止', failed: '启动失败', unavailable: '状态不可用' };
      element('napcat-runtime-state').textContent = runtimeLabels[data.runtime.state] || '状态未知';
    }
    badge.textContent = labels[data.state] || '状态未知';
    badge.className = `pill ${data.state === 'online' ? '' : data.state === 'unconfigured' ? 'off' : 'warn'}`;
    element('napcat-service').textContent = data.reachable ? '运行中' : data.configured ? '未连接' : '未配置';
    element('napcat-message').textContent = data.messageConnected ? '已连接' : data.state === 'online' ? '待接通' : '等待 QQ 登录';
    element('napcat-checked').textContent = date(data.checkedAt);
    element('napcat-event').textContent = data.lastEventAt ? date(data.lastEventAt) : '暂无';
    const image = element('napcat-qr-image');
    const hasQr = data.state === 'waiting' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrCode || '');
    image.hidden = !hasQr;
    if (hasQr && image.getAttribute('src') !== data.qrCode) image.src = data.qrCode;
    if (!hasQr) image.removeAttribute('src');
    element('napcat-qr-empty').hidden = hasQr;
    element('napcat-qr-empty').textContent = data.state === 'online' ? '✓ 已登录' : data.state === 'offline' ? 'QQ 已掉线' : data.state === 'unconfigured' ? '请先保存右侧连接配置' : data.reachable ? '正在等待登录二维码' : '连接 NapCat 后显示二维码';
    const account = element('napcat-account');
    account.hidden = !data.account?.userId;
    account.textContent = data.account ? `${data.account.nickname || 'QQ'} · ${data.account.userId}` : '';
    const hints = { online: data.messageConnected ? '消息 API 已连接。发送 time 测试消息接收与回复。' : config.bundled ? 'QQ 登录成功，正在自动接通消息…' : '已登录 QQ，点击「接通消息收发」完成连接。', offline: config.bundled ? 'QQ 已掉线。若无法自动恢复，请点击「重启 QQ 内核」重新扫码。' : 'QQ 已掉线，请检查 NapCat 日志或在 NapCat 中重新发起登录。', waiting: '请使用手机 QQ 扫码，并在手机上确认登录。', unconfigured: config.bundled ? '内置 QQ 未初始化，请检查镜像是否完整。' : '先保存 NapCat 管理地址和 WebUI Token。' };
    element('napcat-hint').textContent = hints[data.state] || '请检查右侧连接配置，以及 NapCat 是否正在运行。';
    showError(data.autoError || data.runtime?.error || data.error);
    buttons();
  }
  function displayUpdate(data) {
    updateInfo = data;
    updateBusy = ['checking', 'downloading', 'extracting', 'switching'].includes(data.state);
    element('napcat-version').textContent = `v${data.currentVersion}`;
    element('napcat-update-status').textContent = `${data.message || ''}${data.state === 'downloading' ? ` · ${data.progress || 0}%` : ''}${data.latestVersion ? `（最新 v${data.latestVersion}）` : ''}`;
    element('napcat-update-check').disabled = updateBusy;
    element('napcat-update-install').hidden = !data.available || !data.compatible;
    element('napcat-update-install').disabled = updateBusy;
    element('napcat-update-rollback').hidden = !data.canRollback;
    element('napcat-update-rollback').disabled = updateBusy;
    element('napcat-restart').disabled = updateBusy;
  }
  async function poll() {
    clearTimeout(timer);
    if (!current()) return;
    const sequence = ++pollSequence;
    const revision = statusRevision;
    try {
      const [data, update] = await Promise.all([api('/napcat/status'), config.bundled ? api('/napcat/updates') : null]);
      if (current() && sequence === pollSequence && revision === statusRevision) {
        display(data);
        if (update) displayUpdate(update);
      }
    } catch (error) { if (current() && sequence === pollSequence && revision === statusRevision) showError(error.message); }
    finally { if (current() && sequence === pollSequence) timer = setTimeout(poll, 4000); }
  }
  panel.addEventListener('input', () => {
    dirty = true;
    element('napcat-config-status').textContent = '配置有未保存的修改；登录状态仍使用已保存配置';
    notice('');
    buttons();
  });
  panel.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; statusRevision++; buttons(); notice('');
    try {
      let onebotUrl = element('napcat-onebot').value.trim();
      if (!onebotUrl) {
        const url = new URL(element('napcat-url').value);
        url.port = '3000'; onebotUrl = url.origin;
      }
      const saved = await api('/napcat', { method: 'PUT', body: { webuiUrl: element('napcat-url').value.trim(), webuiToken: element('napcat-token').value, onebotUrl, callbackBaseUrl: element('napcat-callback').value.trim() } });
      if (!current()) return;
      element('napcat-token').value = saved.webuiToken;
      element('napcat-onebot').value = saved.onebotUrl;
      element('qq-callback').value = `${saved.callbackBaseUrl}/api/qq/events?token=${settings.webhookToken}`;
      dirty = false;
      element('napcat-config-status').textContent = '配置已保存，正在检查连接';
      notice('配置已保存。二维码出现后，请使用手机 QQ 扫码登录。');
      await poll();
    } catch (error) { if (current()) showError(error.message); }
    finally { if (current()) { busy = false; buttons(); } }
  };
  element('napcat-refresh').onclick = async () => {
    if (busy) return;
    busy = true; statusRevision++; buttons(); notice('');
    try {
      await api('/napcat/qrcode/refresh', { method: 'POST' });
      if (current()) { notice('已请求新的二维码，请稍候。'); await poll(); }
    } catch (error) { if (current()) showError(error.message); }
    finally { if (current()) { busy = false; buttons(); } }
  };
  element('napcat-connect').onclick = async () => {
    if (busy) return;
    busy = true; statusRevision++; buttons(); notice('');
    try {
      const result = await api('/napcat/connect', { method: 'POST' });
      if (!current()) return;
      notice(result.message);
      const updated = await api('/qq');
      if (!current()) return;
      element('qq-endpoint').value = updated.endpoint;
      element('qq-token').value = updated.accessToken;
      element('qq-enabled').checked = updated.enabled;
      await poll();
    } catch (error) { if (current()) showError(error.message); }
    finally { if (current()) { busy = false; buttons(); } }
  };
  element('qq-save').onclick = async () => {
    try {
      await api('/qq', { method: 'PUT', body: { endpoint: element('qq-endpoint').value, accessToken: element('qq-token').value, enabled: element('qq-enabled').checked } });
      if (current()) { toast('手动配置已保存'); reload(); }
    } catch (error) { if (current()) element('qq-result').textContent = error.message; }
  };
  element('qq-test').onclick = async () => {
    const out = element('qq-result'); out.textContent = '正在测试消息 API…';
    try { const info = await api('/qq/test', { method: 'POST' }); if (current()) out.textContent = `已连接：${info.nickname || 'QQ'} (${info.userId})`; }
    catch (error) { if (current()) out.textContent = error.message; }
  };
  if (config.bundled) element('napcat-restart').onclick = async () => {
    const button = element('napcat-restart'); button.disabled = true;
    try {
      await api('/napcat/restart', { method: 'POST' });
      if (current()) notice('QQ 内核正在重启，稍候即可重新扫码。');
    } catch (error) { if (current()) showError(error.message); }
    finally { if (current()) button.disabled = false; }
  };
  if (config.bundled) for (const action of ['check', 'install', 'rollback']) {
    element(`napcat-update-${action}`).onclick = async () => {
      if (updateBusy) return;
      updateBusy = true;
      for (const name of ['check', 'install', 'rollback']) element(`napcat-update-${name}`).disabled = true;
      element('napcat-restart').disabled = true;
      try {
        await api(`/napcat/updates/${action}`, { method: 'POST', body: { version: updateInfo?.latestVersion || '' } });
        if (current()) await poll();
      } catch (error) {
        if (current()) {
          displayUpdate(updateInfo || {});
          element('napcat-update-status').textContent = error.message;
        }
      }
    };
  }
  void poll();
  return () => { alive = false; clearTimeout(timer); };
}
