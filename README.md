# xiaomizhou

独立运行的消息机器人管理后台。当前实现系统管理、本地插件开发、个人 QQ、QQ 官方机器人、企业微信自建应用的成员私聊、GPT/Gemini 对话，以及按规则转发和商品链接返利转链。

## 已发布 v0.3.20：NapCat 群转发

v0.3.18 将 Linux QQ、NapCat Shell 内核及原生库一起打进小米粥：一个容器，后台直接扫码，内部自动配置消息收发。包含 NapCat 4.18.42、Linux QQ 3.2.34-53644，以及内核在线更新、失败自动回滚和手动回滚。

完整镜像面向 Intel/AMD x86_64 飞牛设备。发布流程必须通过自动化测试和真实 QQ/NapCat 生成登录二维码的检查，才上传镜像并创建 [GitHub Release](https://github.com/najiuwanan511/xiaomizhou/releases)。安装前确认 v0.3.20 发布成功；仅推送源码不会生成新镜像。个人账号的扫码确认及消息收发仍需在设备上验证。详情见 [内核与更新说明](xiaomizhou/docs/napcat-integrated.md)。

v0.3.15 起支持转发原消息文字、链接、图片和图文，并把 QQ 合并聊天记录拆成普通消息，
由当前登录 QQ 逐条发送。转发规则提供原图开关、拆分开关和发送间隔；队列支持去重与自动重试。
接入步骤、群号填写和排错见 [NapCat 群转发教程](xiaomizhou/docs/napcat-forwarding.md)。

v0.3.16 新增每条转发规则的关键词拦截、文字／链接替换、删除文案、替换顺序调整和处理预览。
合并消息按节点逐条处理，关键词同时检查原文与最终文案。

## 中文日志与个人 QQ 日志

v0.3.19 将日志级别、模块和常见事件改为中文，已有英文记录也会在查看时转换。运行日志支持按级别和模块筛选、每 5 秒自动刷新及暂停刷新；长消息编号自动换行。

「个人 QQ」页面新增独立日志，记录 NapCat 登录、掉线、连接、内核更新，以及个人 QQ 消息的插件、AI、返利、回复、转发与失败重试。其他渠道的记录不会混入；来源不明的历史插件／返利日志只保留在全局日志。上游未识别的技术错误保留原文和错误码，便于排错。

已安装完整 v0.3.18 或 v0.3.19 镜像的用户可在「在线更新」升级小米粥至 v0.3.20，也可更新完整镜像。两种方式均保留原数据卷。

## QQ 掉线提醒

v0.3.20 在「个人 QQ → QQ 掉线提醒」中增加 PushPlus（微信接收）、企业微信机器人和邮件三种通知渠道。默认关闭，填写渠道凭证、保存并发送测试通知，确认收到后开启。默认持续离线 60 秒后提醒，每 15 秒后台检测一次；关闭浏览器也继续运行。同一次掉线成功通知后不重复发送，支持恢复通知、失败重试和重启后继续监测。

首次检测到 QQ 在线后才开始判断掉线，首次扫码前不会误报。邮件使用 SMTP SSL/TLS 直连，通常为 465 端口。通知详情、渠道设置与限制见 [掉线提醒说明](xiaomizhou/docs/qq-offline-notifications.md)。

## SnowCat 单内核与启停（试用镜像）

当前开发版已移除 NapCat 运行包、框架切换及 NapCat 在线更新，只内置 SnowCat。个人 QQ 页面提供「启动内核」「停止内核」「重启内核」。停止会结束 QQ 和虚拟显示进程，保留登录数据，暂停个人 QQ 掉线提醒与消息重试；重启小米粥仍保持关闭，需主动启动才恢复。其他渠道和后台继续运行。

本次涉及启动器、QQ 运行包和依赖，必须升级完整镜像，不能仅在旧版后台在线更新。旧 v0.3.20 安装命令仍安装 NapCat，不包含此功能；下方 NapCat 版本说明为已发布历史。

采用未经修改的官方 SnowCat v6.0.0 固定源码和 Linux QQ 3.2.34-53644。本次已通过 95 项应用测试、Linux x86_64 真实二维码、停止进程、重启容器保持关闭和恢复启动检查（[记录](https://github.com/najiuwanan511/xiaomizhou/actions/runs/43857416908)），详情见 [SnowCat 构建与验证说明](xiaomizhou/docs/snowcat-integrated.md)。账号实机收发和长期稳定性仍需验证。

试用镜像已发布，适用于 Intel/AMD x86_64 飞牛。若此前使用本 README 的默认一键命令安装，可在飞牛 SSH 执行下面命令，拉取完整 SnowCat 镜像并重建容器，保留原数据卷：

```bash
curl -fsSL https://raw.githubusercontent.com/najiuwanan511/xiaomizhou/codex/snowcat-adapter/xiaomizhou/compose.snowcat-preview.yml | sudo docker compose -p xiaomizhou -f - up -d --pull always
```

命令固定已验证的镜像摘要，沿用 xiaomizhou 项目、8090 端口和 xiaomizhou_xiaomizhou-data 卷。原卷必须存在，找不到时会报错，不会创建空卷替代。自定义项目名、端口或绑定目录的安装，请在原 Compose 配置中替换镜像并保留原挂载。登录小米粥的原管理员账号后，进入「个人 QQ」重新扫码；原 NapCat 登录状态不会迁移给 SnowCat。

[试用镜像构建与发布记录](https://github.com/najiuwanan511/xiaomizhou/actions/runs/43858715129)。正式 latest 和 v0.3.20 标签保持不变，试用镜像尚未通过真实账号长期收发与稳定性验收。

## 自动视频解析（尚未正式发布）

新增「视频解析」页面，开启后直接识别个人 QQ 私聊或群聊中的抖音、快手、皮皮虾分享链接，无需添加“解析”等命令。支持完整分享文案和常见 QQ 分享卡片；成功后先回复视频，再回复从原平台读取的完整标题，不附加分享口令、作者标签或推广文案。

默认关闭，可选择平台、是否回复私聊、允许的群号及单文件上限（默认 20 MB，最高 50 MB）。每条消息处理第一个已启用平台的视频链接；匹配后不再执行同条消息的 AI、插件与转发规则。合并聊天记录和图文作品暂不解析。文件大小和格式在发送前检查，QQ 回调重试及服务重启不会重复发送已经成功的视频。

抖音分享页缺少作品数据时会尝试官方网页详情接口；可能需要在后台填写自己的有效网页 Cookie，接口响应中隐藏凭证，Cookie 只发送给固定的抖音官方详情地址。不要在聊天或日志中分享 Cookie。皮皮虾普通播放地址可能带水印，目前只接受明确提供的原片或无水印标志；无法确认时提示失败，不替换为评论中的其他视频。作者压入画面的水印不能去除。

当前仅完成模拟平台和模拟 OneBot 的自动化测试。用户提供的真实抖音样例在本次无 Cookie 的环境中没有返回视频数据，尚未完成真实视频下载、无水印画面检查和个人 QQ 实际发送验收；快手及皮皮虾也需要目标设备真实链接验证。此功能尚不在已发布的 v0.3.20 镜像中，详见 [视频解析说明](xiaomizhou/docs/video-parsing.md)。

## 内置命令

v0.3.17 起，发送 `time`、`/time`、`时间` 或 `当前时间`，直接返回设备系统当前时间，
显示北京时间（UTC+8），无需 AI。QQ 官方机器人在群中使用 `@机器人 time`。

## 飞牛 OS 安装（已发布 v0.3.20）

已启用 Docker 的飞牛设备可通过 SSH 一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/najiuwanan511/xiaomizhou/v0.3.20/xiaomizhou/compose.image.yml | sudo docker compose -p xiaomizhou -f - up -d
```

此命令使用 `xiaomizhou` 项目和命名数据卷；已有其他项目名或绑定目录的用户，请在原项目中更新镜像并保留原挂载。

安装应用中心的 **Docker** 并启动。确认 [Releases](https://github.com/najiuwanan511/xiaomizhou/releases) 中有 v0.3.20 后，在飞牛 Docker 应用中打开
「Compose」→「新增项目」，项目名称填 `xiaomizhou`，粘贴下方配置并启动：

```yaml
services:
  xiaomizhou:
    image: ghcr.io/najiuwanan511/xiaomizhou:v0.3.20
    container_name: xiaomizhou
    restart: unless-stopped
    ports:
      - "8090:8090"
    environment:
      TZ: Asia/Shanghai
      PORT: "8090"
      DATA_DIR: /app/data
    volumes:
      - xiaomizhou-data:/app/data
    shm_size: 256mb
    stop_grace_period: 15s
    security_opt:
      - no-new-privileges:true

volumes:
  xiaomizhou-data:
```

飞牛需要能连接 `ghcr.io` 拉取镜像。数据库保存在 Docker 命名卷 `xiaomizhou-data` 中，
删除或重建容器不会清除该卷；卸载项目时不要选择删除卷。完整配置也见
[镜像 Compose 文件](xiaomizhou/compose.image.yml)。

启动后访问 `http://飞牛IP:8090`，首次创建管理员账号（密码至少 12 位），再进入「个人 QQ」，等待内核启动并用手机 QQ 扫码、确认登录。消息接口和回调由小米粥自动设置。

如果 8090 被占用，将上面的 `"8090:8090"` 改为 `"8091:8090"`，改用 `http://飞牛IP:8091`。如果 GHCR 拉取失败，查看飞牛 Docker 的错误详情并检查设备网络，不要改成不存在的镜像地址。

从 v0.3.17 及更早版本升级，需要更换完整镜像；旧版后台在线更新无法安装新增依赖和 QQ 运行环境。迁移时保留原数据卷或挂载原数据目录，不要新建空卷替代旧数据。

也可从源码构建，步骤见 [当前完整内核构建说明](xiaomizhou/docs/snowcat-integrated.md)。仓库的 `Dockerfile`/`compose.yml` 是轻量开发环境，不包含 QQ；当前开发版内置 SnowCat 使用 `Dockerfile.bundled`/`compose.bundled.yml`。

## 已发布版本的更新命令

在飞牛 Docker 的 Compose 项目中，将 `image` 改成 [Releases](https://github.com/najiuwanan511/xiaomizhou/releases) 中已成功发布的目标版本标签，拉取并重建容器，保留 `xiaomizhou-data` 卷。`latest` 也指向最近一次成功发布的镜像；使用固定标签便于确认安装版本。

小米粥后端依赖未变化的发布版，可在后台「在线更新」安装。NapCat 内核在「个人 QQ → NapCat 在线更新」独立检查、升级和回滚。目前更新源为第三方发行归档；官方 GitHub 当前没有可下载的 Releases，不保证归档会持续更新。

完整迁移或升级前，备份整个数据卷。后台下载的 SQLite 备份只包含数据库，不包含 QQ 登录文件、内核版本与配置备份。

## 卸载命令

图形界面镜像安装：在飞牛 Docker 中停止并删除 `xiaomizhou` Compose 项目；默认保留
`xiaomizhou-data` 卷。彻底删除数据前，请先下载数据库备份。

源码安装：在飞牛 SSH 中执行以下命令，停止并移除容器及其本地构建镜像：

```sh
cd "$HOME/xiaomizhou-napcat/xiaomizhou"
docker compose -f compose.bundled.yml down --rmi local
```

此命令保留源码和 `data/`，以后可以重新安装且原配置仍在。需要彻底删除时，先备份
`$HOME/xiaomizhou-napcat/xiaomizhou/data/`，再通过飞牛文件管理器删除 `$HOME/xiaomizhou-napcat/`。

## 本地开发

需要 Node.js 24。进入项目目录后运行：

```sh
cd xiaomizhou
pnpm install --frozen-lockfile
node server.js
```

访问 `http://localhost:8090` 初始化管理员。完整配置和功能边界见 [部署说明](xiaomizhou/README.md)。

运行数据保存在 `xiaomizhou/data/`，不会提交到 Git。升级已有本地安装时保留整个 `data/` 目录；数据库文件名 `ownman.db` 暂时维持兼容。

## 当前边界

- 微信 ClawBot 与个人微信尚未接通；企业微信仅支持自建应用成员私聊文字消息。
- 京东、淘宝、拼多多真实返利接口需要按各自联盟账号配置适配服务；测试模式不生成推广链接。
- QQ、企业微信的真实平台收发需要在各自账号和权限配置完成后验证。
- 本地插件编辑只应开放给可信管理员，管理端口不应直接暴露公网。

运行测试：

```sh
cd xiaomizhou
node --test
```
