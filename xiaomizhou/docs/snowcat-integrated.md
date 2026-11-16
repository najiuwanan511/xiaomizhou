# SnowCat 实验适配

当前为开发分支功能，未替换正式版 NapCat，未发布 SnowCat 镜像。现有 v0.3.20 安装命令仍安装 NapCat。

## 已实现

- 个人 QQ 的连接配置可选择 NapCat 或 SnowCat，继续使用 OneBot v11 收发协议。
- 管理接口支持状态、扫码、刷新二维码、接通消息、保存快速登录账号。
- 区分等待扫码、已确认并初始化中、在线和掉线。掉线或初始化时不再显示旧二维码，也不会提前写入消息配置。
- 切换外部框架或管理连接后停用旧消息连接，成功接通新框架后恢复。
- 内置模式通过环境变量 `QQ_FRAMEWORK=napcat|snowcat` 选择内核，默认 NapCat；需要包含适配启动器的完整镜像，不能只更新网页。
- SnowCat 使用 `data/snowcat`、`data/snowcat-qq-home`、`data/snowcat-private.json` 和 `data/snowcat-runtime.json`，保留原 NapCat 数据。
- 内置 SnowCat 可从页面请求重启；禁用 NapCat 独立更新接口，避免把 NapCat 包装到 SnowCat 目录中。SnowCat 暂需重新构建完整镜像更新。

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

## Linux 构建验证

`Dockerfile.snowcat` 在完整小米粥镜像上加入未修改的 SnowCat Shell、Linux 原生库及 WebUI，沿用已经锁定的 Linux QQ 3.2.34-53644。源码地址、提交、压缩包大小及 SHA-256 锁定在 `napcat-runtime.lock.json` 的 `snowcat` 字段；它不代表 QQ/SnowCat 组合已通过兼容性验收。

```bash
base="$(node scripts/prepare-napcat-image.js)"
docker build -f Dockerfile.bundled --build-arg "NAPCAT_BASE_IMAGE=$base" -t xiaomizhou/qq-experiment:local .
docker build -f Dockerfile.snowcat --build-arg XIAOMIZHOU_BASE_IMAGE=xiaomizhou/qq-experiment:local -t xiaomizhou/snowcat-experiment:local .
```

构建只执行上游 `build:webui` 和 `build:shell` 运行包目标。官方标签的插件 SDK 声明生成目标另有类型解析错误，SDK 不参与 Shell/WebUI 运行，也不随本实验镜像发布；不修改源码来修复或掩盖它。

在 Intel/AMD x86_64 飞牛设备上自行构建后，可用独立项目启动测试：

```bash
docker compose -p xiaomizhou-snowcat-test -f compose.snowcat.yml up -d
```

访问 `http://飞牛IP:18090`。此配置使用单独的测试数据卷，不覆盖原配置；试用同一个 QQ 账号前停用原 QQ 内核，避免两边同时登录。当前没有可直接拉取的 SnowCat 实验镜像，不能把正式 v0.3.20 镜像加上环境变量就当作已安装 SnowCat。

GitHub Actions 的 `SnowCat experiment` 分别检查适配测试、上游真实鉴权实现、完整 Linux 镜像构建及真实二维码。只使用临时测试容器，不上传镜像、不创建正式 Release。鉴权失败或无法生成二维码时必须报告失败。

扫码图片生成不等于账号已经登录。个人账号实际扫码、群聊和私聊的文字/图片/视频收发、掉线提醒及长期稳定性仍需真实账号验收，当前未通过。SnowCat 同样使用 QQ 运行时注入，不能保证避免“外挂检测”或踢下线。

## 许可与回退

上游使用 Limited Redistribution License for NapCat，包含非商业使用、保留完整许可与来源，以及修改代码公开发布的限制。本适配通过小米粥外部启动器和协议接口接入，不改上游内核；实验镜像保留完整 LICENSE 和固定提交来源。

实验验证不使用现有生产数据卷。将来实机切换前先停止原容器并备份整个数据卷，确保同一数据卷只被一个小米粥容器使用。含双内核的实验镜像可用 `QQ_FRAMEWORK=napcat` 并重新创建容器回退，也可恢复原正式镜像；不要删除数据卷。
