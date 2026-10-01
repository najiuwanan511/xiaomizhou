# xiaomizhou

独立运行的机器人管理后台原型，不依赖 autMan 可执行文件或授权服务。当前版本覆盖
系统管理、插件管理、本地开发及返利转链接口的第一阶段。界面根据 autMan 的管理工作流
重新实现，没有复制其内置前端文件；可执行文件中的页面资源缺少独立工程结构，公开
旧版本前端也没有明确的再利用许可。

## 启动

需要 Node.js 24 或 Docker。开发机安装依赖并运行：

```sh
cd xiaomizhou
pnpm install --frozen-lockfile
node server.js
```

浏览器访问 `http://localhost:8090`，首次访问设置管理员密码（至少 12 位）。数据库
存于 `xiaomizhou/data/ownman.db`，请备份整个 `data/`。数据库文件名保留以兼容已有安装。
飞牛 OS 的安装和维护命令见下文。请勿将 8090 直接映射到公网；账号密码、Webhook
令牌及联盟密钥保存在本地数据库中。

## 飞牛 OS 安装与维护

### Docker 图形界面安装

在飞牛 Docker 应用的「Compose」中点击「新增项目」，项目名称填 `xiaomizhou`，
将 [compose.image.yml](compose.image.yml) 的内容粘贴到 Compose 编辑框并启动。
此方式直接拉取 `ghcr.io/najiuwanan511/xiaomizhou:latest`，无需在飞牛上下载源码、
安装 Git 或构建 Node 镜像。NAS 仍需能访问 `ghcr.io`。数据库存于 Docker 命名卷
`xiaomizhou-data`，删除容器时请保留卷。启动后访问 `http://飞牛IP:8090`。

如果 8090 已被占用，只改 Compose 的端口映射左侧数字（如 `"8091:8090"`），
再访问 `http://飞牛IP:8091`。镜像更新时重新拉取 `latest` 并重新创建容器，
或在依赖未变化时使用后台「在线更新」。卸载时删除 Compose 项目；需要保留账号及配置
就不要删除命名卷。

### SSH 源码安装

1. 在飞牛 OS 应用中心安装并启动 Docker，确认飞牛有足够空间，并在系统设置中启用 SSH。
   在电脑终端运行 `ssh 飞牛用户名@飞牛IP` 登录；确认 `docker compose version` 和
   `git --version` 都能正常执行。运行 Docker 命令的账号还需要有 Docker 权限。
2. 在飞牛 SSH 中安装：

   ```sh
   git clone https://github.com/najiuwanan511/xiaomizhou.git "$HOME/xiaomizhou"
   cd "$HOME/xiaomizhou/xiaomizhou"
   docker compose up -d --build
   docker compose ps
   ```

3. 在同一局域网的浏览器打开 `http://飞牛IP:8090`，创建管理员账号。项目把宿主机的
   `./data` 挂载到容器 `/app/data`，重建容器时会保留数据库和在线更新文件。不要把管理端口
   直接暴露到公网。

如果使用飞牛 Docker 图形界面，可从 GitHub 下载源码 ZIP 并解压，创建 Compose 项目时选择
源码内的 `xiaomizhou/compose.yml`，将项目工作目录设为该文件所在的 `xiaomizhou` 目录，
再构建并启动。这样 `./data` 才会指向正确的数据目录。若宿主机 8090 端口已被占用，
把 `compose.yml` 的 `"8090:8090"` 改成 `"其他空闲端口:8090"`，浏览器访问相应端口。
使用 ZIP 安装时无法运行下方的 `git pull`；更新需下载新版源码、保留原 `data/`，
再用原项目重建容器。后台「在线更新」适用于依赖未变化的正式发布版。

升级代码或 Docker 依赖时，在飞牛 SSH 中执行：

```sh
cd "$HOME/xiaomizhou"
git pull --ff-only
cd xiaomizhou
docker compose up -d --build
```

需要查看启动日志时执行 `docker compose logs --tail=100 xiaomizhou`。卸载服务和本地构建镜像：

```sh
cd "$HOME/xiaomizhou/xiaomizhou"
docker compose down --rmi local
```

卸载命令保留 `data/` 和源码。若要彻底删除，先下载数据库备份，再通过文件管理器删除
`$HOME/xiaomizhou/`。如果安装时选择了其他目录，上述命令中的 `$HOME/xiaomizhou` 要
替换成实际路径；不要删除其他 Docker 项目的数据目录。

## 已实现

- 管理员初始化、登录退出、系统名称、活动日志。
- 管理员可在「系统设置」下载一致的 SQLite 数据库备份。
- 本地 JavaScript 插件的创建、编辑、启停、删除与模拟消息测试。
- `POST /api/events` 通用消息入口，使用 `X-Webhook-Token` 鉴权；按启用插件生成
  `reply` 或 `forward` 动作，返回给调用方执行。
- 个人 QQ 的 OneBot 11 HTTP 接入：接收 NapCat 上报，执行插件并发送 QQ 私聊、群聊回复和 QQ 内转发。
- QQ 官方机器人 WebSocket 接入：使用 QQ 开放平台 AppID、AppSecret 接收私聊与群内 @ 消息，并调用官方消息接口回复。
- 企业微信自建应用接入：验证加密回调，接收成员文字消息，并通过应用消息接口回复或转发给成员。
- AI 大脑：配置 OpenAI GPT 或 Google Gemini 的 API 密钥和模型，在指定渠道生成文字回复，并保留最近六轮会话上下文。
- 转发规则：按来源平台和会话 ID 配置目标，可选择全部文字或仅含网页链接。
- 京东、淘宝、拼多多商品 URL 识别。测试模式不生成推广链接。
- 可开关的消息自动转链：真实接口成功后回复推广链接，并替换转发规则里的原链接；接口失败时阻止原链接自动转发。
- 真实接口适配入口：按平台配置 HTTPS 端点、推广位和 Bearer 密钥。端点需接收
  `{ "platform", "url", "campaignId" }` 并返回 `{ "url": "https://..." }`。

插件示例：

```js
function handle(event, api) {
  if (event.channel === 'qq' && event.text === '你好') {
    api.reply('你好');
  }
}
```

消息入口示例：

```sh
curl -X POST 'http://localhost:8090/api/events' \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Token: 后台系统设置中的令牌' \
  -d '{"channel":"qq","chatId":"123","userId":"456","text":"你好"}'
```

通用消息入口只返回动作。个人 QQ 和 QQ 官方机器人收到消息时会执行可支持的发送动作；
微信 ClawBot、个人微信仍需独立适配器。京东、淘宝、拼多多的官方联盟
接口签名和授权方式也各不相同，需拿到你的接口文档后实现对应适配器。真实接口返回
链接后，还应在联盟后台核对推广位和订单归因。系统不把测试链接伪装成可结算链接。

只给可信的管理员开放本地插件编辑权限。`node:vm` 的执行时限与禁用动态代码生成
降低意外错误的影响，但不是强安全隔离；不要安装不可信插件或开放公开插件市场。

## 个人 QQ 接入

1. 在 NapCat 中启用 OneBot 11 正向 HTTP 服务，并设置 Access Token。将 HTTP API 地址
   （例如 `http://飞牛局域网IP:3000`）和 Access Token 填入 xiaomizhou 的「个人 QQ」页面。
2. 在 NapCat 中配置 HTTP POST 消息上报地址，使用「个人 QQ」页面显示的完整回调 URL。
   如果支持自定义请求头，也可改用 `X-Webhook-Token` 头，值取自「系统设置」。
3. 保存配置、启用消息接收并点击「测试连接」。用另一个 QQ 账号私聊测试，再测试群聊。
   NapCat 和 xiaomizhou 需处于互相可访问的局域网或 Docker 网络；不建议将这些端口映射到公网。

回调只处理文字消息，忽略自己的消息以及非消息通知。插件中的 `api.reply(text)` 回复当前会话；
`api.forward('qq', 'group:123456', text)` 转发到 QQ 群；私聊目标为 `private:QQ号`。
尚未接入的平台目标会显示为未支持并写入日志。OneBot 消息 ID 用于去重已成功发送的动作；
发送失败返回 HTTP 502，可由上报端重试。回调 URL 内含密钥，不要分享到公开场所。

「转发规则」页可以直接配置 QQ 群 A 到 QQ 群 B 的自动转发；在尚无真实群号时可用 A/B/C
保存草稿并保持停用，拿到群号后再改为实际 ID 并启用。个人微信目标可先记录规则，
但当前还不能实际发送。

## QQ 官方机器人接入

在 [QQ 开放平台](https://q.qq.com/) 创建机器人并开通单聊消息及群内 @ 消息事件。
在 xiaomizhou「QQ 机器人」页填入 AppID、AppSecret，保存并启用。连接方式为 WebSocket，
飞牛 NAS 需要能主动访问 QQ 开放平台，无需开放公网回调地址。页面显示「已连接」后，
用另一个 QQ 账号私聊或在群里 @ 机器人验证消息。真实收发还需使用你的机器人账号验证；
本项目的测试只覆盖模拟平台协议。

插件中以 `event.channel === 'qqbot'` 匹配官方机器人消息，`api.reply(text)` 回复当前会话。
转发规则的 QQ 官方机器人目标格式为 `group:OpenID` 或 `private:OpenID`，不是普通 QQ 号。
向其他会话主动发消息取决于开放平台权限和主动消息限制，未获授权时会在日志显示发送错误。

## 企业微信自建应用接入

在企业微信管理后台创建自建应用，记录 CorpID、AgentID 和应用 Secret。到 xiaomizhou
「微信接入」页填写这些值，以及回调 Token、EncodingAESKey，保存并启用。企业微信
回调 URL 配置为 `https://你的域名/api/wecom/callback`。该地址必须能从企业微信
服务器通过 HTTPS 访问；NAS 仅有局域网地址时需要可信的 HTTPS 反向代理或隧道。
点击「测试鉴权」只验证应用凭据，之后还需在企业微信后台完成回调验证并发送一条文字
消息验证收发。应用可见范围要包含测试成员。

收到的成员文字消息以 `event.channel === 'wecom'` 进入插件和转发规则，
`event.chatId` 为成员 UserID。`api.reply(text)` 回复成员，转发目标写为
`user:成员UserID`。该模式不支持普通微信群或企业微信群消息同步。真实企业微信账号
收发仍需现场验证；当前测试使用模拟的加密回调和接口响应。

「微信接入」页继续列出个人微信、微信 ClawBot 的待接入状态。
autMan 的微信 ClawBot 适配器属于原项目，xiaomizhou 不能直接复用它的配置或登录态；
腾讯的 `@tencent-weixin/openclaw-weixin` 频道插件依赖 OpenClaw 运行时，不能直接作为
xiaomizhou 适配器安装。下一阶段需要选择独立运行的 iLink/ClawBot 桥接服务，并验证其
会话 ID、主动发送和双向转发接口。

## 返利自动转链

京粉与淘宝联盟的申请、字段填写和单链接验收步骤见[对接教程](docs/affiliate-jd-taobao.md)。

在「返利转链」页选择平台和接口类型。京东官方接口填写联盟应用的 AppKey、AppSecret。
默认的 QQ / 微信社交媒体模式调用 `jd.union.open.promotion.bysubunionid.get`，需向京东联盟
申请接口权限，推广位 ID 可选。网站 / APP 模式调用 `jd.union.open.promotion.common.get`，
需要站点 ID / App ID，并确保与实际备案的投放来源一致。只有京粉账号不代表已有 API 权限。

淘宝官方接口填写开放平台应用的 AppKey、AppSecret 和推广位 ID（PID 第三段），调用
`taobao.tbk.dg.general.link.convert`。普通商品复制链接的转链权限可能需要单独邀约申请。
若只有联盟后台账号而没有开放平台应用密钥，请先到对应平台申请。拼多多和已有部署可继续
选择自定义 HTTPS 转链接口。

保存后先用「单链接测试」确认返回推广链接，再启用「消息自动转链」。测试模式只显示识别结果，
不会向群里发送虚构的返利链接。自动转链最多处理一条消息中的前五个已识别商品链接。
失败详情会出现在运行日志和消息接口响应中。真实转链后还应在联盟后台核对推广位和订单归因。

## AI 大脑

在「AI 大脑」页选择 OpenAI 或 Gemini，填写对应服务商的 API 密钥和模型 ID，保存后先用
「测试回复」验证，再启用需要的消息渠道。测试不会发送到 QQ 或微信，也不写入会话记录。
切换服务商时需要重新填写该服务商的密钥。
私聊会直接交给 AI；QQ 官方机器人处理群内 @ 消息；个人 QQ 群聊仅处理以所设前缀开头
的消息。插件或返利流程已经回复、转链失败时，AI 不再追加回复。AI 每个用户会话读取
最近六轮已发送成功的问答。记录最多保留 30 天或 5000 轮，后台可随时清空。

对话文本和最近六轮历史会发送给所选模型服务商。API 密钥保存在本地数据库，管理接口
仅返回掩码；数据库备份也包含密钥。AI 目前只生成文字，不会执行定时提醒、修复接口
或修改系统配置。OpenAI 使用 Responses API，Gemini 使用 generateContent API。

## 备份与恢复

「系统设置」中的「下载数据库备份」会生成 SQLite 快照。备份包含管理员密码哈希、
消息接入令牌及联盟密钥，应妥善保管。恢复时先停止 xiaomizhou 容器或 Node 服务，
将备份文件替换 `data/ownman.db`，移走旧数据库旁的 `ownman.db-wal` 和
`ownman.db-shm` 文件后再启动服务。不要在服务运行时直接覆盖数据库文件。

## 在线更新与发布

首次启用在线更新时，需从 `v0.2.0` 或更新的源码在飞牛 Docker 项目中重建并启动一次：

```sh
cd xiaomizhou
docker compose up -d --build
```

此后在后台「在线更新」页检查 GitHub Releases，核对更新说明，再点击安装。服务只接受
`najiuwanan511/xiaomizhou` 仓库的正式发布包，下载后校验 SHA-256，并校验包内文件列表。
安装前数据库快照保存在 `data/releases/before-v版本-时间.db`；运行代码放在
`data/releases/v版本/`，因此容器重建不会丢失已安装的较新版本。启动器确认新版能响应
`/api/bootstrap` 后完成切换；若新版启动失败，会恢复上一版代码。数据库不会自动回滚。

在线更新只支持 Docker 启动器和依赖未变化的版本。直接运行 `node server.js` 可以检查版本，
但需手动更新代码并重启；如果发布版更改了 npm 依赖或 Dockerfile，后台会提示重建容器。
重建后的镜像版本若比已安装的在线版本新，会自动运行镜像版本。

维护者每次升级时先修改 `package.json` 版本，推送代码后创建同名 `v版本` 标签并推送。
GitHub Actions 会校验标签与版本一致，生成带 SHA-256 校验文件的发布包，并在 GitHub
Releases 创建对应版本。不要手动修改已经发布的标签或资产。

## 验证

```sh
node --test
```

测试包含管理员初始化、插件创建与执行、消息 Webhook、返利测试模式及错误输入。
