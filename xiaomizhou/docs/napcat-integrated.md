# 小米粥内置 NapCat 与在线更新

v0.3.18 完整镜像包含 NapCat 4.18.42 + Linux QQ 3.2.34-53644。归档通过固定 SHA-256 校验，发布流水线在 Linux Runner 上执行完整镜像构建与真实内核登录二维码检查，成功后才发布镜像和 Release。请以 [Releases](https://github.com/najiuwanan511/xiaomizhou/releases) 和对应 Actions 成功记录确认版本是否已上线。自动化检查不登录个人账号，实际扫码确认及消息收发仍需在目标设备验证。

发布镜像目前为 linux/amd64，适用于 Intel/AMD x86_64 飞牛设备；ARM64 使用下文的源码构建步骤。

## 安装后的使用方式

用户只安装一个小米粥镜像、启动一个容器。镜像同时包含小米粥、完整 NapCat Shell 发行包及原生库、Linux QQ、Xvfb 和进程启动器。无需第二个 NapCat 容器，也无需填写 WebUI 地址、Token 或回调。

进入「个人 QQ」扫码，在手机确认后，小米粥自动接通消息收发。页面显示 QQ 在线状态、消息 API 状态、登录二维码、内核状态与版本，并提供二维码刷新、重启、检查更新、升级及回滚。已有插件、AI 与转发规则沿用。

完整内核随镜像保留，没有重写 NapCat 协议代码。小米粥当前转发功能支持的消息类型仍以 [转发说明](napcat-forwarding.md) 为准；并非每一个 NapCat API 都新增了对应页面。

## NapCat 在线更新

在「个人 QQ → NapCat 在线更新」点击「检查更新」，发现适用版本后点击「升级 NapCat」。更新源目前是 [XingYunStar/NapCatQQ 发行归档](https://github.com/XingYunStar/NapCatQQ/releases)，页面只显示此来源发布的稳定版本，不保证归档会持续提供新版本。

更新器独立于小米粥后端，由容器启动器运行：

1. 从固定仓库检查发行版，要求完整 `NapCat.Shell.zip` 与 GitHub 提供的 SHA-256 摘要。
2. 下载到临时目录，检查大小和摘要，限制解压大小并拒绝目录穿越、重复路径、符号链接和不完整的内核。
3. 检查当前 Linux 架构所需原生库，停止 QQ，备份 NapCat 配置，记录待确认版本，再启动新内核。
4. 90 秒内通过鉴权后的 QQ 登录接口返回在线状态或登录二维码，才确认版本切换。检查失败自动恢复旧内核及升级前配置。
5. 升级中断后，下次启动恢复旧版。成功升级后也可手动「回滚上一版」。QQ 登录文件、数据库、用户插件和转发规则不随内核替换。

升级会暂时中断 QQ 消息收发，QQ 仍可能要求重新扫码。启动检查能发现启动及登录接口不兼容，不能保证所有消息功能兼容；扫码后仍应验证消息收发与转发，发现问题可手动回滚。

仅 NapCat Shell 在当前配套 QQ 环境内更新；跨 NapCat 大版本直接要求升级完整小米粥镜像。如果新版需要更新 Linux QQ、系统库或启动器，也需更新完整镜像。部署新镜像后不继续沿用基于旧内核镜像选择的下载版本。

升级包、上一版和配置备份存放于 `/app/data/napcat-releases/`。当前实现不自动清理历史发行目录与备份，需预留磁盘空间；不要在运行中删除当前版本或回滚依赖目录。SQLite 下载备份不包含这些文件和 QQ 登录数据，迁移时备份整个数据卷。

## 一个应用中的进程

- `launcher.js` 同时管理 QQ/NapCat 和小米粥后端，QQ 的 Electron 入口通过独立 bootstrap 加载未修改的 NapCat。
- 更新小米粥后端只重启后端，保留 QQ 进程；更新 NapCat 只重启 QQ 内核。
- 退出容器时结束整个 QQ/Xvfb 进程组，连续崩溃后停止重试并显示错误。
- 内部管理与消息端口监听 `127.0.0.1`，只对外开放小米粥的 `8090`。
- 首次启动随机生成管理密钥，保存在数据卷中，不发送给浏览器或写入命令行。
- 登录后保存账号，重启尝试用已保存会话快速登录；需要确认时仍由用户扫码。

数据卷 `/app/data` 保存数据库、`napcat-private.json`、`napcat/` 配置及日志、`qq-home/` 账号数据和内核更新版本。不要把私人数据打入镜像。

## 从已锁定的归档构建

构建者需要 Docker、Node.js 24、tar，以及访问 GitHub、npm 和镜像仓库的网络。安装用户只需最终的小米粥镜像。

默认输入是 [v4.18.42 归档](https://github.com/XingYunStar/NapCatQQ/releases/tag/v4.18.42)，amd64/arm64 的 URL、大小、SHA-256 以及 QQ 版本固定在 `napcat-runtime.lock.json`。构建准备脚本下载、校验并 `docker load`，不给构建阶段执行远程安装脚本。

先下载源码并进入应用目录：

```sh
git clone --branch v0.3.18 --single-branch https://github.com/najiuwanan511/xiaomizhou.git "$HOME/xiaomizhou-napcat"
cd "$HOME/xiaomizhou-napcat/xiaomizhou"
```

以下默认 amd64，需要宿主机有 Node.js 24：

```sh
node scripts/prepare-napcat-image.js
docker compose -f compose.bundled.yml up -d --build
```

飞牛没有安装 Node.js 时，amd64 设备可使用临时容器下载校验，再由宿主机导入镜像：

```sh
docker run --rm -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/prepare-napcat-image.js --download-only
docker load --input data/build-inputs/napcat-docker-v4.18.42-amd64.tar
docker tag mlikiowa/napcat-docker:v4.18.42 xiaomizhou/napcat-runtime:4.18.42-amd64
docker compose -f compose.bundled.yml up -d --build
```

每一步成功后再执行下一步。归档下载约 584 MiB，构建还需下载 QQ 系统依赖与 Node 镜像。使用 SSH 的账号需有 Docker 权限。

ARM64 构建在具有 Node.js 24 的 ARM64 Docker 主机上执行：

```sh
NAPCAT_BUILD_ARCH=arm64 node scripts/prepare-napcat-image.js
NAPCAT_BASE_IMAGE=xiaomizhou/napcat-runtime:4.18.42-arm64 docker compose -f compose.bundled.yml up -d --build
```

归档在镜像内以 `/app/NapCat.Shell.zip` 保存 NapCat，构建阶段先解开，再与 `/opt/QQ` 一起复制到最终镜像。原发行的配置、日志、缓存不沿用；保留默认配置及发行静态资源。构建时检查 QQ 和 NapCat 版本与锁文件一致。

`NAPCAT_BASE_IMAGE` 只用于构建输入，不是第二个运行服务。若覆盖该参数，输入须匹配锁文件中的版本并为干净的完整发行；自定义路径可使用 `NAPCAT_DIST_DIR` 与 `QQ_INSTALL_DIR`。原 `Dockerfile`/`compose.yml` 仍是轻量开发环境；要内置 QQ 使用 `Dockerfile.bundled`/`compose.bundled.yml`。

## 发布前的真实验收

GitHub 发布流程默认准备已锁定归档，构建完整镜像后启动临时容器，运行 `scripts/smoke-bundled.js`。只有实际 QQ/NapCat 生成登录二维码后才推送镜像。该检查不使用模拟服务，也不会登录个人账号。

还需在目标设备实际扫码，用另一个账号验证 `time` 回复、图片与群转发；验证真实内核升级和回滚。自动化二维码检查不等于个人账号收发消息已经验收。只有发布流程成功后对应镜像才会上线，单独推送源码不会改变 `latest`。

## 来源、许可与兼容模式

NapCat 来源归档、原仓库及许可证保留在 `third-party/`。NapCat 许可包含非商业用途限制，商业分发需另行获得相应授权。QQ 由腾讯提供，保留运行文件及所附声明。

早期接口参考保留源码提交 `c5bc48da1fd4af1a08e63546ecc6876a7dd1824b`；随后已对实际 v4.18.42 Shell 中的登录接口、路径环境变量和 WebUI 配置字段进行静态核对。最终兼容性仍以实际镜像检查为准。

不带内核的开发模式继续支持外部 NapCat 接入。完整镜像隐藏外部连接配置，不接受数据库旧设置覆盖内部地址与密钥。
