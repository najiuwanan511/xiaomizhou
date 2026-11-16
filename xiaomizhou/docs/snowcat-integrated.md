# SnowCat 单内核与启停

开发分支已删除 NapCat 运行包和更新器，只保留 SnowCat。已发布 Linux x86_64 SnowCat 试用镜像（[发布记录](https://github.com/najiuwanan511/xiaomizhou/actions/runs/43858715129)），正式 latest 和 v0.3.20 标签保持不变。旧 v0.3.20 安装命令仍安装 NapCat。

## 飞牛一键升级

适用于此前使用默认一键命令安装的 xiaomizhou 项目，保留现有命名数据卷：

```bash
curl -fsSL https://raw.githubusercontent.com/najiuwanan511/xiaomizhou/codex/snowcat-adapter/xiaomizhou/compose.snowcat-preview.yml | sudo docker compose -p xiaomizhou -f - up -d --pull always
```

升级配置固定镜像摘要 sha256:e38202dc986a46bc97ca8bd7722334fc90b77dc743f78f472c1356341951876c，只包含已验证的 Linux amd64 镜像。沿用 8090 端口，原 xiaomizhou_xiaomizhou-data 卷必须已存在；不存在则报错，不创建替代空卷。自定义项目、端口或绑定目录应在原 Compose 中仅替换镜像，保留所有原挂载。更新后使用原管理员账号登录，再在「个人 QQ」重新扫码。


## 使用方式

进入「个人 QQ」可扫码、查看状态，并使用「启动内核」「停止内核」「重启内核」。停止会结束 QQ/Xvfb 进程，保留登录数据。关闭偏好写入数据卷的 qq-kernel-control.json，重启容器后继续保持关闭；启动后重新读取已保存的快速登录账号。

主动停止期间不进行内核状态网络轮询、个人 QQ 消息重试或掉线提醒。QQ 再次上线后重新开始掉线监测。QQ 官方机器人、企业微信、插件管理等其他功能继续运行。已经交给通知渠道的通知无法撤回。

本次必须更换完整镜像，旧版后台在线更新不能替换父进程启动器和运行包。原数据卷中历史 NapCat 登录文件不主动删除，新内核使用独立的 data/snowcat、data/snowcat-qq-home 与私有密钥文件。

## 版本选择与上游凭证回归

当前主分支研究源码 [`e465fbaf7c66e79161c458b457c897cdae6258b4`](https://github.com/DandanLLab/SnowCatQQ/tree/e465fbaf7c66e79161c458b457c897cdae6258b4) 存在下面的凭证缺陷，因此实验构建改用官方 [`v6.0.0`](https://github.com/DandanLLab/SnowCatQQ/tree/v6.0.0) 的固定提交 `e292824161b038996250d6da37a38d9a26f9ac10`，版本标识 `6.0.0-experimental.e292824`。该标签的密码、签名和凭证校验独立执行全部通过。

上游 `packages/snowcat-webui-backend/src/helper/SignToken.ts` 中，`validateCredentialWithinOneHour()` 将凭证内的密码哈希与 `generatePasswordHash(token)` 比较，而后者每次生成新随机盐。因此正常登录签发、HMAC 正确的凭证也无法通过后续管理请求校验。旧 SHA-256 登录和新 scrypt 登录均复现此问题。上游中间件对扫码、状态和配置接口调用了这段校验。

独立复现（在小米粥应用目录执行，Node 24）：

```bash
node scripts/prepare-snowcat-source.js data/snowcat-source
node scripts/check-snowcat-auth.js data/snowcat-source --require-working
```

脚本只移除 TypeScript 类型，并将上游内存存储模块的导入地址重定向到同一份原始实现，不修改鉴权函数、不加载 QQ 或原生钩子，也不打印测试令牌。默认下载当前锁定的官方 v6.0.0，输出密码、签名、凭证验证全部通过；将路径指向上述主分支提交时，凭证验证失败并以非零状态结束。

官方标签默认签名密钥有弱随机回退。小米粥使用它已有的 `NAPCAT_WEBUI_JWT_SECRET_KEY` 环境接口，提供单独的 256 位加密随机密钥并持久保存，内置 WebUI 只监听容器回环地址，不使用该回退、不修改内核源码。

小米粥不会跳过鉴权或关闭上游两步验证。开启两步验证的外部内核暂只能使用已配置好的手动 OneBot 接入。对于反复签发无效凭证的内核，后台会暂缓登录重试，避免每次轮询耗尽上游登录次数。

## 构建与验证

在应用目录、Linux x86_64 Docker 环境执行：

```bash
base="$(node scripts/prepare-qq-image.js)"
docker build -f Dockerfile.bundled --build-arg "QQ_BASE_IMAGE=$base" -t xiaomizhou/snowcat-experiment:local .
docker compose -p xiaomizhou-snowcat-test -f compose.snowcat.yml up -d
```

访问 http://飞牛IP:18090。试用配置使用独立数据卷。此配置用于本地源码构建测试；普通安装可使用上方已发布的试用镜像。不要将正式 v0.3.20 加环境变量当作 SnowCat 版本。

qq-runtime.lock.json 固定 SnowCat 源码提交、SHA-256、大小及 Linux QQ 版本。旧 NapCat 发行归档仅作为提取 Linux QQ 的构建输入，最终镜像不复制 NapCat 目录或 Shell ZIP。SnowCat 上游仍使用 napcat.mjs、config/napcat.json 和 NAPCAT_* 名称，这些属于 SnowCat 原始接口，并非混入第二套内核。

构建只执行上游 build:webui 和 build:shell。官方标签的插件 SDK 声明目标存在类型解析错误，SDK 不参与 Shell/WebUI 运行，不随镜像发布。

2026-11-16，本次单内核与启停通过 95 项应用测试、锁定上游真实鉴权检查，以及 Linux x86_64 完整镜像构建和运行验收（[成功记录](https://github.com/najiuwanan511/xiaomizhou/actions/runs/43857416908)，运行代码提交 58e9e804f72ea70c1d6afb3aab755e1017ce0493）。验收确认最终镜像无 NapCat 运行目录或 Shell ZIP；停止后真实 QQ/Xvfb 进程退出、3000/6099 端口关闭；重启容器仍关闭；重新启动恢复真实登录二维码，再次停止也成功。未登录真实账号。

本地浏览器使用模拟 QQ 管理服务和真实进程控制器验证了启动、停止、重启按钮及刷新后状态：停止后清除二维码、暂停消息状态、仅启用启动按钮。模拟界面验收不代替上述 Linux 真实运行验收。

GitHub Actions 的 SnowCat experiment 在应用测试、上游鉴权和临时容器真实启停验收全部成功后，上传 snowcat-提交短号 与 snowcat-preview 两种试用标签，不改正式 latest 或版本标签，不创建正式 Release。真实账号扫码、文字/图片/视频收发、掉线提醒与长期稳定性仍需实机验收。SnowCat 同样使用 QQ 运行时注入，不能保证避免外挂检测。

## 许可与数据保护

SnowCat 使用 Limited Redistribution License for NapCat，包含非商业、保留完整许可和来源、修改代码公开发布等限制。本适配通过外部启动器和协议接口接入，不修改上游内核；镜像保留 LICENSE 和固定来源记录。

升级前停止原容器并备份整个数据卷，同一卷只允许一个小米粥容器使用。需要回退时恢复原镜像和备份数据；新镜像不再提供内核选择。不要删除数据卷。
