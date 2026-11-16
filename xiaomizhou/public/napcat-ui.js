export function logPanel(id, title, description, { escapeHtml, icon }, personal = false) {
  const areas = { qq: '个人 QQ', napcat: 'QQ 内核', qqbot: 'QQ 官方机器人', wecom: '企业微信', weixin: '微信', plugin: '插件', forward: '消息转发', rebate: '返利转链', video: '视频解析', ai: 'AI 大脑', system: '系统', server: '服务', event: '消息接入', update: '在线更新', backup: '数据备份' };
  return `<section class="panel log-panel" id="${id}" aria-label="${escapeHtml(title)}"><div class="pad"><div class="section-head"><h2>${escapeHtml(title)}</h2><button class="btn small" data-log-refresh>${icon('refresh-cw')} 刷新</button></div><p class="muted">${escapeHtml(description)}</p><div class="row log-controls"><label>级别 <select data-log-level aria-label="日志级别"><option value="">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select></label><label>模块 <select data-log-area aria-label="日志模块"><option value="">全部模块</option>${Object.entries(areas).filter(([key]) => !personal || ['qq', 'napcat', 'plugin', 'forward', 'rebate', 'ai', 'server', 'event'].includes(key)).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label><label class="switch"><input type="checkbox" data-log-auto checked> 自动刷新</label></div><p class="muted" data-log-status role="status">正在读取日志…</p></div><div data-log-rows></div></section>`;
}

export function bindLogPanel({ id, api, escapeHtml, date, active, personal = false }) {
  const panel = document.getElementById(id);
  const get = selector => panel.querySelector(selector);
  let alive = true, timer, sequence = 0;
  const current = () => alive && panel.isConnected && active();
  async function refresh() {
    clearTimeout(timer);
    if (!current()) return;
    const request = ++sequence;
    const params = new URLSearchParams();
    if (personal) params.set('source', 'qq');
    if (get('[data-log-level]').value) params.set('level', get('[data-log-level]').value);
    if (get('[data-log-area]').value) params.set('area', get('[data-log-area]').value);
    try {
      const data = await api(`/logs?${params}`);
      if (!current() || request !== sequence) return;
      get('[data-log-rows]').innerHTML = data.logs.length ? `<div class="table-wrap"><table class="log-table"><thead><tr><th>时间</th><th>级别</th><th>模块</th><th>详情</th></tr></thead><tbody>${data.logs.map(item => `<tr><td class="mono">${escapeHtml(date(item.time))}</td><td><span class="pill ${['error', 'warn'].includes(item.level) ? 'warn' : 'off'}">${escapeHtml(item.levelLabel || item.level)}</span></td><td>${escapeHtml(item.areaLabel || item.area)}</td><td class="log-message">${escapeHtml(item.message)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">暂无符合条件的日志</div>';
      get('[data-log-status]').textContent = `最近 ${data.logs.length} 条 · 更新于 ${date(new Date())}${get('[data-log-auto]').checked ? ' · 每 5 秒自动刷新' : ' · 已暂停自动刷新'}`;
    } catch (error) {
      if (current() && request === sequence) get('[data-log-status]').textContent = `日志刷新失败：${error.message}。可点击刷新重试。`;
    } finally {
      if (current() && request === sequence && get('[data-log-auto]').checked) timer = setTimeout(refresh, 5000);
    }
  }
  get('[data-log-refresh]').onclick = refresh;
  for (const selector of ['[data-log-level]', '[data-log-area]', '[data-log-auto]']) get(selector).onchange = refresh;
  void refresh();
  return () => { alive = false; sequence++; clearTimeout(timer); };
}

export async function renderNapcat({ api, shell, heading, icon, escapeHtml, date, toast, active, reload }) {
  const [config, qq, settings, notificationConfig] = await Promise.all([api('/napcat'), api('/qq'), api('/settings'), api('/qq/notifications')]);
  if (!active()) return () => {};
  const coreName = 'SnowCat';
  shell(`${heading(`个人 QQ · ${coreName}`, '扫码登录 QQ，查看在线状态并接通消息收发')}
    <div class="notice">SnowCat 为实验适配，采用官方 v6.0.0 固定源码。Linux x86_64 已通过启动与真实登录二维码检查，飞牛实机扫码及账号收发仍需验证。更换内核不能保证避免 QQ 风控掉线。</div>
    <div class="two-col napcat-panels">
      <section class="panel pad">
        <div class="section-head"><h2>QQ 扫码登录</h2><span class="pill off" id="napcat-state">正在检查</span></div>
        <div class="napcat-login">
          <div class="napcat-qr" id="napcat-qr"><img id="napcat-qr-image" hidden alt="使用手机 QQ 扫描此二维码登录" width="256" height="256"><div id="napcat-qr-empty">保存连接配置后显示二维码</div></div>
          <div id="napcat-account" class="napcat-account" hidden></div>
          <p id="napcat-hint" class="muted" role="status">正在读取 ${coreName} 状态…</p>
          <div class="row"><button class="btn" id="napcat-refresh" disabled>${icon('refresh-cw')} 刷新二维码</button><button class="btn primary" id="napcat-connect" ${config.bundled ? 'hidden' : ''} disabled>${icon('plug-zap')} 接通消息收发</button></div>
        </div>
        <div id="napcat-error" class="alert" role="alert" hidden></div>
        <div id="napcat-notice" class="notice" role="status" hidden></div>
        <dl class="napcat-status"><div><dt>${coreName} 服务</dt><dd id="napcat-service">检查中</dd></div><div><dt>消息 API</dt><dd id="napcat-message">检查中</dd></div><div><dt>最近检查</dt><dd id="napcat-checked">—</dd></div><div><dt>最近收到消息</dt><dd id="napcat-event">${qq.lastEventAt ? escapeHtml(date(qq.lastEventAt)) : '暂无'}</dd></div></dl>
        <p class="help">${config.bundled ? '使用手机 QQ 扫码并确认登录，小米粥会自动接通消息。无需单独配置 QQ 内核。' : '使用手机 QQ 扫码并确认登录，再点击「接通消息收发」。'}连接成功后即可使用插件、AI 回复和转发规则。</p>
      </section>
      ${config.bundled ? `<section class="panel pad" id="napcat-runtime-panel">
        <div class="section-head"><h2>内置 QQ · ${coreName}</h2><span class="pill" id="napcat-runtime-state">检查中</span></div>
        <p class="muted">完整 QQ 运行环境和 ${coreName} 内核随小米粥镜像一起安装，由小米粥自动启动、连接和恢复。</p>
        <div class="notice">连接地址、密钥和消息回调均由小米粥内部管理。</div>
        <p class="help section">登录数据随小米粥数据目录持久保存。QQ 掉线且无法重新扫码时，可重启内核；现有插件和转发规则会保留。</p>
        <div class="row"><button class="btn primary" id="napcat-start" disabled>启动内核</button><button class="btn" id="napcat-stop" disabled>停止内核</button><button class="btn" id="napcat-restart" disabled>重启内核</button></div>
        <p class="help">不用 QQ 时可停止内核，释放 QQ 进程占用的内存。登录数据保留，重启小米粥后仍保持关闭；主动停止期间暂停掉线提醒和消息重试。</p>
        <p class="muted">SnowCat 随完整镜像更新。</p>
        ${config.runtimeControl ? '' : '<p class="alert">当前启动器不支持启停，请更新完整镜像。</p>'}
      </section>` : ''}
      <section class="panel pad" ${config.bundled ? 'hidden' : ''}>
        <div class="section-head"><h2>QQ 框架连接配置</h2></div>
        <p class="muted">SnowCat需已在其他设备或容器运行，并提供兼容的 WebUI 与 OneBot v11 接口。</p>
        <form id="napcat-form">
          <p class="muted">QQ 内核：SnowCat</p>
          <div class="field"><label for="napcat-url">内核管理地址</label><input id="napcat-url" type="url" value="${escapeHtml(config.webuiUrl)}" placeholder="http://qq-core:6099" required><small>填写小米粥服务能访问的SnowCat WebUI 地址。</small></div>
          <div class="field"><label for="napcat-token">内核 WebUI Token</label><input id="napcat-token" type="password" autocomplete="off" value="${escapeHtml(config.webuiToken)}" required><small>用于管理和扫码登录，与消息 API 的 Access Token 不同。</small></div>
          <div class="field"><label for="napcat-onebot">消息 API 地址</label><input id="napcat-onebot" type="url" value="${escapeHtml(config.onebotUrl)}" placeholder="http://qq-core:3000"><small>自动接通时创建此端口的消息服务；留空使用管理地址的主机和 3000 端口。</small></div>
          <div class="field"><label for="napcat-callback">小米粥访问地址</label><input id="napcat-callback" type="url" value="${escapeHtml(config.callbackBaseUrl || location.origin)}" placeholder="http://xiaomizhou:8090" required><small>填写 QQ 内核能访问的小米粥地址。同一套容器部署可用 http://xiaomizhou:8090。</small></div>
          <button class="btn primary" id="napcat-save" type="submit">${icon('save')} 保存并连接</button>
          <p class="muted" id="napcat-config-status" role="status">当前显示的是已保存配置</p>
        </form>
        <p class="help">「接通消息收发」会创建或更新小米粥专用的消息服务和回调，保留其他连接配置。</p>
      </section>
    </div>
    <section class="panel pad section" id="qq-notification-panel">
      <div class="section-head"><h2>QQ 掉线提醒</h2><span class="pill off" id="qq-notification-state">未启用</span></div>
      <p class="muted">通过独立渠道接收掉线与恢复通知，关闭网页后仍会在后台检测。首次扫码前不提醒，同一次掉线成功通知后不重复发送。</p>
      <form id="qq-notification-form">
        <div class="two-col"><div>
          <div class="field"><label class="switch"><input type="checkbox" id="qq-notification-enabled" ${notificationConfig.enabled ? 'checked' : ''}> 启用 QQ 掉线提醒</label></div>
          <div class="field"><label for="qq-notification-provider">通知渠道</label><select id="qq-notification-provider"><option value="pushplus">PushPlus（微信接收）</option><option value="wecom">企业微信机器人</option><option value="email">邮件（SMTP 安全连接）</option></select></div>
          <div class="field"><label for="qq-notification-delay">持续离线多少秒后提醒</label><input id="qq-notification-delay" type="number" min="30" max="3600" step="1" value="${notificationConfig.delaySeconds || 60}"><small>默认 60 秒，每 15 秒检测一次，短暂断网不提醒。</small></div>
          <div class="field"><label class="switch"><input type="checkbox" id="qq-notification-recovery" ${notificationConfig.recovery !== false ? 'checked' : ''}> 恢复上线后发送通知</label></div>
        </div><div>
          <div data-notification-provider="pushplus"><div class="field"><label for="qq-notification-pushplusToken">PushPlus Token</label><input id="qq-notification-pushplusToken" type="password" autocomplete="off" value="${escapeHtml(notificationConfig.pushplusToken || '')}"><small>在 PushPlus 获取 Token 并绑定微信接收账号。</small></div></div>
          <div data-notification-provider="wecom" hidden><div class="field"><label for="qq-notification-wecomKey">企业微信机器人 Webhook key</label><input id="qq-notification-wecomKey" type="password" autocomplete="off" value="${escapeHtml(notificationConfig.wecomKey || '')}"><small>在企业微信群中添加机器人，填写 Webhook 地址中 key= 后面的内容。</small></div></div>
          <div data-notification-provider="email" hidden>
            <div class="two-col"><div class="field"><label for="qq-notification-smtpHost">SMTP 服务器</label><input id="qq-notification-smtpHost" value="${escapeHtml(notificationConfig.smtpHost || '')}" placeholder="smtp.qq.com" autocomplete="off"></div><div class="field"><label for="qq-notification-smtpPort">安全连接端口</label><input id="qq-notification-smtpPort" type="number" min="1" max="65535" value="${notificationConfig.smtpPort || 465}"></div></div>
            <div class="field"><label for="qq-notification-smtpUser">SMTP 账号</label><input id="qq-notification-smtpUser" value="${escapeHtml(notificationConfig.smtpUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="qq-notification-smtpPassword">SMTP 授权码</label><input id="qq-notification-smtpPassword" type="password" value="${escapeHtml(notificationConfig.smtpPassword || '')}" autocomplete="off"><small>填写邮箱的 SMTP 授权码。使用 SSL/TLS 直连，通常为 465 端口。</small></div>
            <div class="two-col"><div class="field"><label for="qq-notification-smtpFrom">发件邮箱</label><input id="qq-notification-smtpFrom" type="email" value="${escapeHtml(notificationConfig.smtpFrom || '')}"></div><div class="field"><label for="qq-notification-smtpTo">收件邮箱</label><input id="qq-notification-smtpTo" type="email" value="${escapeHtml(notificationConfig.smtpTo || '')}"></div></div>
          </div>
        </div></div>
        <div class="row"><button class="btn primary" type="submit" id="qq-notification-save">保存提醒设置</button><button class="btn" type="button" id="qq-notification-test">发送测试通知</button></div>
        <p id="qq-notification-result" class="muted" role="status">先保存配置，再发送测试通知并到接收渠道确认。</p>
      </form>
      <p id="qq-notification-status" class="muted" role="status"></p>
      <p class="help">只检测个人 QQ；QQ 等待重新扫码、内核服务不可达或鉴权异常也会计入持续异常。发送失败会自动重试。小米粥容器必须保持运行且能够访问通知渠道；整个 NAS 关机或断网时，无法即时向外发送通知。</p>
    </section>
    <details class="panel pad section" id="qq-manual" ${config.bundled ? 'hidden' : ''}><summary>手动接入与排错</summary><div class="two-col section">
      <div><div class="field"><label for="qq-endpoint">HTTP API 地址</label><input id="qq-endpoint" value="${escapeHtml(qq.endpoint)}" placeholder="http://qq-core:3000"></div><div class="field"><label for="qq-token">消息 API Access Token</label><input id="qq-token" type="password" autocomplete="off" value="${escapeHtml(qq.accessToken)}"></div><div class="field"><label class="switch"><input id="qq-enabled" type="checkbox" ${qq.enabled ? 'checked' : ''}> 启用消息接收</label></div><div class="row"><button class="btn" id="qq-save">保存手动配置</button><button class="btn" id="qq-test">测试消息连接</button></div><p id="qq-result" class="muted" role="status">${escapeHtml(qq.lastError || '已有 OneBot v11 消息服务可以在此手动接入')}</p></div>
      <div><div class="field"><label for="qq-callback">HTTP POST 回调地址</label><input id="qq-callback" class="mono" readonly value="${escapeHtml(`${config.callbackBaseUrl || location.origin}/api/qq/events?token=${settings.webhookToken}`)}"><small>包含接入令牌，请妥善保管。自动接通时会写入所选 QQ 内核。</small></div><p class="help">手动配置不影响已有转发规则。群转发目标填写 group:群号，私聊目标填写 private:QQ号。发送 time 或“时间”可测试回复。</p></div>
    </div></details><div class="section">${logPanel('qq-logs', '个人 QQ 日志', '仅显示个人 QQ 与SnowCat 内核的连接、消息处理、回复、转发和失败重试。保留最近 100 条匹配记录。', { escapeHtml, icon }, true)}</div>`);

  const element = id => document.getElementById(id);
  const panel = element('napcat-form');
  let alive = true;
  let timer;
  let busy = false;
  let dirty = false;
  let latest = null;
  let runtimeBusy = false;
  let statusRevision = 0;
  let pollSequence = 0;
  const current = () => alive && active() && panel.isConnected;
  const notice = message => { element('napcat-notice').textContent = message; element('napcat-notice').hidden = !message; };
  const showError = message => { element('napcat-error').textContent = message || ''; element('napcat-error').hidden = !message; };
  let savedNotifications = notificationConfig;
  let notificationDirty = false, notificationBusy = false;
  const notificationFields = ['enabled', 'provider', 'delay', 'recovery', 'pushplusToken', 'wecomKey', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'smtpFrom', 'smtpTo'];
  function notificationButtons() {
    element('qq-notification-save').disabled = notificationBusy;
    element('qq-notification-test').disabled = notificationBusy || notificationDirty;
  }
  function notificationStatus(status = savedNotifications.status || {}) {
    const badge = element('qq-notification-state');
    badge.textContent = savedNotifications.enabled ? status.lastError ? '通知失败' : status.armed ? '监测中' : '等待 QQ 上线' : '未启用';
    badge.className = `pill ${!savedNotifications.enabled ? 'off' : status.lastError ? 'warn' : ''}`;
    element('qq-notification-status').textContent = !savedNotifications.enabled ? '提醒尚未启用。可以先保存渠道配置并发送测试通知。' : `${status.armed ? status.offlineSince ? `发现持续异常：${date(status.offlineSince)}${status.offlineNotified ? '，掉线通知已提交' : '，正在等待提醒或重试'}` : 'QQ 监测已就绪' : '等待首次检测到 QQ 在线，首次扫码前不会发掉线通知'}${status.lastCheckedAt ? `；最近检测：${date(status.lastCheckedAt)}` : ''}${status.lastNotificationAt ? `；最近通知：${date(status.lastNotificationAt)}` : ''}${status.lastError ? `；发送失败：${status.lastError}` : ''}`;
  }
  const notificationForm = element('qq-notification-form');
  element('qq-notification-provider').value = notificationConfig.provider || 'pushplus';
  function notificationProvider() {
    document.querySelectorAll('[data-notification-provider]').forEach(group => {
      group.hidden = group.dataset.notificationProvider !== element('qq-notification-provider').value;
      group.querySelectorAll('input').forEach(input => { input.disabled = group.hidden; });
    });
  }
  notificationForm.oninput = () => { notificationDirty = true; element('qq-notification-result').textContent = '设置有未保存的修改，请先保存后再测试。'; notificationButtons(); };
  notificationForm.onchange = () => { notificationForm.oninput(); notificationProvider(); };
  notificationForm.onsubmit = async event => {
    event.preventDefault(); if (notificationBusy) return;
    notificationBusy = true; notificationButtons();
    const input = Object.fromEntries(notificationFields.map(key => [key === 'delay' ? 'delaySeconds' : key, ['enabled', 'recovery'].includes(key) ? element(`qq-notification-${key}`).checked : element(`qq-notification-${key}`).value]));
    try {
      const saved = await api('/qq/notifications', { method: 'PUT', body: input });
      if (!current()) return;
      savedNotifications = saved; notificationDirty = false;
      for (const key of ['pushplusToken', 'wecomKey', 'smtpPassword']) element(`qq-notification-${key}`).value = saved[key];
      element('qq-notification-result').textContent = '提醒设置已保存。请发送测试通知，并到接收渠道确认。';
      notificationStatus(saved.status);
    } catch (error) { if (current()) element('qq-notification-result').textContent = `保存失败：${error.message}`; }
    finally { if (current()) { notificationBusy = false; notificationButtons(); } }
  };
  element('qq-notification-test').onclick = async () => {
    if (notificationBusy || notificationDirty) return;
    notificationBusy = true; notificationButtons(); element('qq-notification-result').textContent = '正在发送测试通知…';
    try { const result = await api('/qq/notifications/test', { method: 'POST' }); if (current()) element('qq-notification-result').textContent = result.message; }
    catch (error) { if (current()) element('qq-notification-result').textContent = `测试失败：${error.message}`; }
    finally { if (current()) { notificationBusy = false; notificationButtons(); } }
  };
  notificationProvider(); notificationStatus();
  function buttons() {
    element('napcat-save').disabled = busy || runtimeBusy;
    if (config.bundled) {
      const off = latest?.runtime?.enabled === false || latest?.state === 'stopped';
      const pending = runtimeBusy || busy || !latest || !config.runtimeControl || latest?.state === 'stopping';
      element('napcat-start').disabled = pending || (!off && latest?.runtime?.state !== 'failed');
      element('napcat-stop').disabled = pending || off;
      element('napcat-restart').disabled = pending || off;
    }
    element('napcat-refresh').disabled = busy || dirty || !latest?.reachable || latest.state !== 'waiting';
    element('napcat-connect').disabled = busy || dirty || latest?.state !== 'online';
  }
  function display(data) {
    if (data.notificationStatus) notificationStatus(data.notificationStatus);
    latest = data;
    if (!dirty) element('napcat-config-status').textContent = '当前显示的是已保存配置';
    const labels = { stopped: '内核已停止', stopping: '正在停止', unconfigured: '待配置', online: 'QQ 在线', offline: 'QQ 已掉线', initializing: '正在初始化', waiting: '等待扫码', 'auth-error': '鉴权失败', unreachable: '服务不可达' };
    const badge = element('napcat-state');
    if (config.bundled && data.runtime) {
      const runtimeLabels = { starting: '启动中', running: '运行中', restarting: '重启中', stopping: '停止中', stopped: '已停止', failed: '启动失败', unavailable: '状态不可用' };
      element('napcat-runtime-state').textContent = runtimeLabels[data.runtime.state] || '状态未知';
    }
    badge.textContent = labels[data.state] || '状态未知';
    badge.className = `pill ${data.state === 'online' ? '' : ['unconfigured', 'stopped'].includes(data.state) ? 'off' : 'warn'}`;
    element('napcat-service').textContent = ['stopped', 'stopping'].includes(data.state) ? '已停止' : data.reachable ? '运行中' : data.configured ? '未连接' : '未配置';
    element('napcat-message').textContent = ['stopped', 'stopping'].includes(data.state) ? '已暂停' : data.messageConnected ? '已连接' : data.state === 'online' ? '待接通' : '等待 QQ 登录';
    element('napcat-checked').textContent = date(data.checkedAt);
    element('napcat-event').textContent = data.lastEventAt ? date(data.lastEventAt) : '暂无';
    const image = element('napcat-qr-image');
    const hasQr = data.state === 'waiting' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrCode || '');
    image.hidden = !hasQr;
    if (hasQr && image.getAttribute('src') !== data.qrCode) image.src = data.qrCode;
    if (!hasQr) image.removeAttribute('src');
    element('napcat-qr-empty').hidden = hasQr;
    element('napcat-qr-empty').textContent = data.state === 'stopped' ? '内核已停止' : data.state === 'stopping' ? '正在停止内核' : data.state === 'online' ? '✓ 已登录' : data.state === 'offline' ? 'QQ 已掉线' : data.state === 'initializing' ? '已扫码，正在初始化' : data.state === 'unconfigured' ? '请先保存右侧连接配置' : data.reachable ? '正在等待登录二维码' : `连接 ${coreName} 后显示二维码`;
    const account = element('napcat-account');
    account.hidden = !data.account?.userId;
    account.textContent = data.account ? `${data.account.nickname || 'QQ'} · ${data.account.userId}` : '';
    const hints = { stopped: '内核已关闭，登录数据已保留。需要使用 QQ 时点击「启动内核」。', stopping: '正在结束 QQ 内核进程，请稍候。', online: data.messageConnected ? '消息 API 已连接。发送 time 测试消息接收与回复。' : config.bundled ? 'QQ 登录成功，正在自动接通消息…' : '已登录 QQ，点击「接通消息收发」完成连接。', offline: config.bundled ? 'QQ 已掉线。若无法自动恢复，请点击「重启 QQ 内核」重新扫码。' : 'QQ 已掉线，请检查 SnowCat 日志或重新发起登录。', waiting: '请使用手机 QQ 扫码，并在手机上确认登录。', unconfigured: config.bundled ? '内置 QQ 未初始化，请检查镜像是否完整。' : '先保存 SnowCat 管理地址和 WebUI Token。' };
    hints.initializing = '手机已确认登录，正在初始化 QQ 内核；请等待就绪后接通消息。';
    element('napcat-hint').textContent = (hints[data.state] || '请检查右侧连接配置，以及 QQ 内核是否正在运行。').replaceAll('NapCat', coreName);
    showError(data.autoError || data.runtime?.error || data.error);
    buttons();
  }
  async function poll() {
    clearTimeout(timer);
    if (!current()) return;
    const sequence = ++pollSequence;
    const revision = statusRevision;
    try {
      const data = await api('/napcat/status');
      if (current() && sequence === pollSequence && revision === statusRevision) {
        display(data);
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
      const saved = await api('/napcat', { method: 'PUT', body: { framework: 'snowcat', webuiUrl: element('napcat-url').value.trim(), webuiToken: element('napcat-token').value, onebotUrl, callbackBaseUrl: element('napcat-callback').value.trim() } });
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
  if (config.bundled) for (const action of ['start', 'stop', 'restart']) {
    element(`napcat-${action}`).onclick = async () => {
      if (runtimeBusy || busy) return;
      runtimeBusy = true; statusRevision++; buttons(); notice(''); showError('');
      try {
        await api(`/napcat/${action}`, { method: 'POST' });
        if (!current()) return;
        notice({ start: '内核已启动，正在准备 QQ 登录。', stop: '内核已停止，登录数据已保留。', restart: '内核已重启，正在准备 QQ 登录。' }[action]);
        await poll();
      } catch (error) { if (current()) showError(error.message); }
      finally { if (current()) { runtimeBusy = false; buttons(); } }
    };
  }
  const disposeLogs = bindLogPanel({ id: 'qq-logs', api, escapeHtml, date, active: current, personal: true });
  void poll();
  return () => { alive = false; clearTimeout(timer); disposeLogs(); };
}
