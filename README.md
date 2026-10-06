# xiaomizhou

独立运行的消息机器人管理后台。当前实现系统管理、本地插件开发、个人 QQ、QQ 官方机器人、企业微信自建应用的成员私聊、GPT/Gemini 对话，以及按规则转发和商品链接返利转链。

## NapCat 群转发

v0.3.15 起支持转发原消息文字、链接、图片和图文，并把 QQ 合并聊天记录拆成普通消息，
由当前登录 QQ 逐条发送。转发规则提供原图开关、拆分开关和发送间隔；队列支持去重与自动重试。
接入步骤、群号填写和排错见 [NapCat 群转发教程](xiaomizhou/docs/napcat-forwarding.md)。

v0.3.16 新增每条转发规则的关键词拦截、文字／链接替换、删除文案、替换顺序调整和处理预览。
合并消息按节点逐条处理，关键词同时检查原文与最终文案。

## 飞牛 OS 安装

推荐使用 Docker 图形界面，无需飞牛下载 GitHub 源码。在飞牛 Docker 应用中打开
「Compose」→「新增项目」，项目名称填 `xiaomizhou`，粘贴下方配置并启动：

```yaml
services:
  xiaomizhou:
    image: ghcr.io/najiuwanan511/xiaomizhou:latest
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
    security_opt:
      - no-new-privileges:true

volumes:
  xiaomizhou-data:
```

飞牛需要能连接 `ghcr.io` 拉取镜像。数据库保存在 Docker 命名卷 `xiaomizhou-data` 中，
删除或重建容器不会清除该卷；卸载项目时不要选择删除卷。完整配置也见
[镜像 Compose 文件](xiaomizhou/compose.image.yml)。

也可以从源码构建。适用于已安装 Docker、启用 SSH，并有 `git` 和 `docker compose` 命令的飞牛 OS：

```sh
git clone https://github.com/najiuwanan511/xiaomizhou.git "$HOME/xiaomizhou"
cd "$HOME/xiaomizhou/xiaomizhou"
docker compose up -d --build
docker compose ps
```

两种方式启动后都在同一局域网访问 `http://飞牛IP:8090`，首次进入时创建管理员账号。源码方式的项目在
`$HOME/xiaomizhou/`，数据库、配置和插件数据在 `$HOME/xiaomizhou/xiaomizhou/data/`。
源码方式首次构建需要飞牛能访问 Docker Hub 和 npm。详细步骤及 Docker
图形界面安装方式见 [飞牛 OS 部署说明](xiaomizhou/README.md#飞牛-os-安装与维护)。

## 更新命令

图形界面镜像安装：在飞牛 Docker 中拉取 `ghcr.io/najiuwanan511/xiaomizhou:latest`，
然后重新创建该 Compose 项目的容器；保留 `xiaomizhou-data` 卷。依赖未变化的发布版也可在
后台「在线更新」页安装。

源码安装：在飞牛 SSH 中执行以下命令，适用于代码或 Docker 依赖有变化时：

```sh
cd "$HOME/xiaomizhou"
git pull --ff-only
cd xiaomizhou
docker compose up -d --build
```

已运行 `v0.2.0` 及以上 Docker 版本时，依赖未变化的正式发布版也可以在后台「在线更新」页安装。
更新前建议在「系统设置」下载数据库备份。更新命令不会删除 `data/`。

## 卸载命令

图形界面镜像安装：在飞牛 Docker 中停止并删除 `xiaomizhou` Compose 项目；默认保留
`xiaomizhou-data` 卷。彻底删除数据前，请先下载数据库备份。

源码安装：在飞牛 SSH 中执行以下命令，停止并移除容器及其本地构建镜像：

```sh
cd "$HOME/xiaomizhou/xiaomizhou"
docker compose down --rmi local
```

此命令保留源码和 `data/`，以后可以重新安装且原配置仍在。需要彻底删除时，先备份
`$HOME/xiaomizhou/xiaomizhou/data/`，再通过飞牛文件管理器删除 `$HOME/xiaomizhou/`。

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
