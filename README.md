# xiaomizhou

独立运行的消息机器人管理后台。当前实现系统管理、本地插件开发、个人 QQ、QQ 官方机器人、企业微信自建应用的成员私聊、GPT/Gemini 对话，以及按规则转发和商品链接返利转链的测试模式。

## 飞牛 OS 安装

适用于已安装 Docker、启用 SSH，并有 `git` 和 `docker compose` 命令的飞牛 OS。通过 SSH 登录飞牛后执行：

```sh
git clone https://github.com/najiuwanan511/xiaomizhou.git "$HOME/xiaomizhou"
cd "$HOME/xiaomizhou/xiaomizhou"
docker compose up -d --build
docker compose ps
```

在同一局域网访问 `http://飞牛IP:8090`，首次进入时创建管理员账号。源码在
`$HOME/xiaomizhou/`，数据库、配置和插件数据在 `$HOME/xiaomizhou/xiaomizhou/data/`。
安装包通过 Docker 构建，首次构建需要飞牛能访问 Docker Hub 和 npm。详细步骤及 Docker
图形界面安装方式见 [飞牛 OS 部署说明](xiaomizhou/README.md#飞牛-os-安装与维护)。

## 更新命令

在飞牛 SSH 中执行以下命令，适用于代码或 Docker 依赖有变化时：

```sh
cd "$HOME/xiaomizhou"
git pull --ff-only
cd xiaomizhou
docker compose up -d --build
```

已运行 `v0.2.0` 及以上 Docker 版本时，依赖未变化的正式发布版也可以在后台「在线更新」页安装。
更新前建议在「系统设置」下载数据库备份。更新命令不会删除 `data/`。

## 卸载命令

在飞牛 SSH 中执行以下命令，停止并移除容器及其本地构建镜像：

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
