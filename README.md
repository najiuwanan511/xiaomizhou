# xiaomizhou

独立运行的消息机器人管理后台。当前实现系统管理、本地插件开发、个人 QQ、QQ 官方机器人、企业微信自建应用的成员私聊、GPT/Gemini 对话，以及按规则转发和商品链接返利转链。

## NapCat 群转发

v0.3.18 将 Linux QQ、NapCat Shell 内核及原生库一起打进小米粥：一个容器，后台直接扫码，内部自动配置消息收发。包含 NapCat 4.18.42、Linux QQ 3.2.34-53644，以及内核在线更新、失败自动回滚和手动回滚。

完整镜像面向 Intel/AMD x86_64 飞牛设备。发布流程必须通过自动化测试和真实 QQ/NapCat 生成登录二维码的检查，才上传镜像并创建 [GitHub Release](https://github.com/najiuwanan511/xiaomizhou/releases)。安装前确认 v0.3.18 发布成功；仅推送源码不会生成新镜像。个人账号的扫码确认及消息收发仍需在设备上验证。详情见 [内核与更新说明](xiaomizhou/docs/napcat-integrated.md)。

v0.3.15 起支持转发原消息文字、链接、图片和图文，并把 QQ 合并聊天记录拆成普通消息，
由当前登录 QQ 逐条发送。转发规则提供原图开关、拆分开关和发送间隔；队列支持去重与自动重试。
接入步骤、群号填写和排错见 [NapCat 群转发教程](xiaomizhou/docs/napcat-forwarding.md)。

v0.3.16 新增每条转发规则的关键词拦截、文字／链接替换、删除文案、替换顺序调整和处理预览。
合并消息按节点逐条处理，关键词同时检查原文与最终文案。

## 内置命令

v0.3.17 起，发送 `time`、`/time`、`时间` 或 `当前时间`，直接返回设备系统当前时间，
显示北京时间（UTC+8），无需 AI。QQ 官方机器人在群中使用 `@机器人 time`。

## 飞牛 OS 安装

安装应用中心的 **Docker** 并启动。确认 [Releases](https://github.com/najiuwanan511/xiaomizhou/releases) 中有 v0.3.18 后，在飞牛 Docker 应用中打开
「Compose」→「新增项目」，项目名称填 `xiaomizhou`，粘贴下方配置并启动：

```yaml
services:
  xiaomizhou:
    image: ghcr.io/najiuwanan511/xiaomizhou:v0.3.18
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

也可从源码构建，步骤见 [完整内核构建说明](xiaomizhou/docs/napcat-integrated.md#从已锁定的归档构建)。仓库的 `Dockerfile`/`compose.yml` 是轻量开发环境，不包含 QQ；内置 NapCat 必须使用 `Dockerfile.bundled`/`compose.bundled.yml`。

## 更新命令

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
