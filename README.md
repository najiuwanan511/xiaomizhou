# xiaomizhou

独立运行的消息机器人管理后台。当前实现系统管理、本地插件开发、个人 QQ、QQ 官方机器人、企业微信自建应用的成员私聊，以及按规则转发和商品链接返利转链的测试模式。

## 启动

需要 Node.js 24。进入项目目录后运行：

```sh
cd xiaomizhou
pnpm install --frozen-lockfile
node server.js
```

访问 `http://localhost:8090` 初始化管理员。飞牛 OS 可在 `xiaomizhou` 目录中执行 `docker compose up -d --build`，然后访问 `http://飞牛IP:8090`。完整配置和功能边界见 [部署说明](xiaomizhou/README.md)。

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
