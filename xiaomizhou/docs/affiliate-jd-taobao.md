# 京粉与淘宝联盟对接 xiaomizhou

本文介绍京东官方直连、折京客接入、淘宝官方直连和折淘客接入；拼多多使用多多进宝官方转链接口。

## 开始前确认

京粉或淘宝联盟账号用于推广和查看收益，但账号本身不等于 API 凭据。xiaomizhou 的官方转链需要平台应用的 AppKey、AppSecret、对应接口权限，以及淘宝推广位 ID 或京东媒体/推广位信息。请在自己的后台填写密钥，不要发送到群聊、截图或公开仓库。

先让 xiaomizhou 保持「消息自动转链」关闭。完成单链接测试和联盟后台归因检查后，再开启自动回复、群转发。

v0.3.7 起，「链接 / 分享文案测试」可直接粘贴手机 APP 复制的整段分享内容。程序自动提取其中的京东、淘宝或拼多多商品链接，保留查询参数；中文标题、换行和打开提示无需手动删除。每次测试只处理一个不同商品链接；群消息自动转链最多处理前五个已识别商品链接。没有 URL 的纯口令暂不支持。

## 一、京东联盟 / 京粉

### 方式 A：折京客（v0.3.6 新增）

适用于通过折淘客的京东板块完成联盟账号授权，再由其提供转链服务的场景。

1. 注册并登录[折京客](https://j.zhetaoke.com/)，进入[京东授权管理](https://j.zhetaoke.com/user/shouquan_jd.aspx)，按页面提示完成自己的京东联盟账号授权。
2. 从[对接密钥](https://j.zhetaoke.com/user/open/open_appkey.aspx)获取折京客 AppKey，准备已授权账号的京东联盟 ID（unionId）。这里不用京东 AppSecret，也不用淘宝授权 SID。
3. 小米粥「返利转链 → 京东 → 接入方式」选择「折京客」，填写折京客 AppKey 和联盟 ID。推广位是折京客接口的可选数字参数，首次测试可留空。两种接入方式的密钥分别保存，切换不会把折京客 Key 当成京东 Key。
4. 保持「请求商品详情」关闭，保存后先用京东商品 URL 执行单链接测试。确认生成链接的商品正确，并在联盟后台核对后续订单归因，再开启消息自动转链和转发。
5. 如需图片、商品名、口令和预估佣金，先按[折京客接口说明](https://j.zhetaoke.com/user/open/open_gaoyongzhuanlian_tkl.aspx)申请商品详情权限，再启用「请求商品详情」。要随消息发送图片，还需开启「附带商品图片」。上游缺少的字段不虚构；预估佣金不是用户最终到账金额，实际以联盟结算为准。

程序使用固定 HTTPS 接口、POST 请求，支持基础响应和详情响应，不需要填写自定义接口地址。未授权、AppKey 错误、详情权限不足等错误会在单链接测试中显示。详情调用失败可关闭详情选项重试基础转链；基础转链也失败时先检查折京客授权和接口调用日志。

### 方式 B：京东官方直连

1. 用京粉关联的账号登录[京东联盟开放平台](https://union.jd.com/openplatform)，核对实名认证、媒体备案、应用及接口权限。具体菜单名称以登录后的平台界面为准。没有应用 AppKey、AppSecret 时，先在联盟开放平台申请或创建应用；京粉 App 的登录密码不能代替这两个字段。
2. 确定实际投放渠道。如果推广链接将发到 QQ、微信等社交会话，申请 `jd.union.open.promotion.bysubunionid.get` 的调用权限；此接口和可选的 `subUnionId` 权限由京东联盟单独管理。xiaomizhou 目前不传 `subUnionId`，但仍需要接口本身的权限。若实际投放在备案的网站或 APP，可使用 `jd.union.open.promotion.common.get`，还需该网站 ID 或 APP ID，且投放来源应与备案信息一致。不要用网站/APP 媒体 ID 为 QQ/微信群推广冒充归因。
3. 在 xiaomizhou 后台进入「返利转链」→「京东」，「投放渠道」选择实际渠道，填写 AppKey、AppSecret。社交媒体模式无需填写站点 ID；网站/APP 模式必须填写站点 ID。已创建推广位时可填推广位 ID，留空则不指定。
4. 保存后粘贴一条参与联盟推广的京东商品完整 URL，例如 `https://item.jd.com/实际SKU.html`，点「执行转链」。看到返回的 HTTPS 推广链接后，打开链接检查商品，再到京东联盟后台核对实际使用的媒体、推广位和后续订单归因。链接生成成功不代表订单一定有效或已结算。

京东接口说明：[联盟 API 列表](https://jos.jd.com/apilist?apiGroupId=531&apiGroupName=%E4%BA%AC%E4%B8%9C%E8%81%94%E7%9B%9Fapi)、[联盟开放平台](https://union.jd.com/openplatform)。权限申请条件和审核结果以平台账号实际显示为准。

## 二、淘宝联盟

### 方式 A：折淘客（v0.3.8 新增）

1. 登录[折淘客](https://www.zhetaoke.com/)，在[授权管理](https://www.zhetaoke.com/user/shouquan.html)授权自己的淘宝联盟账号，取得对应 SID；从[对接密钥](https://www.zhetaoke.com/user/open/open_appkey.aspx)获取折淘客 AppKey。
2. 在淘宝联盟取得完整 PID，格式为 `mm_数字_数字_数字`，并在[折淘客 PID 管理](https://www.zhetaoke.com/user/extend/extend_mypid.aspx)核对设置。PID 必须属于 SID 授权的同一个淘宝账号；这里填写完整 PID，不是官方直连的第三段推广位 ID。
3. 根据[折淘客高佣转链接口文档](https://www.zhetaoke.com/user/open/open_gaoyongzhuanlian_tkl.aspx)，处理手机淘宝复制的内容，需要代理类型 SID、渠道 PID 和对应渠道关系 ID（RID）。RID 是用户完成渠道邀请备案后得到的 `relation_id`，不是 PID 第三段、邀请码或自己随便填写的数字；可从渠道信息查询结果读取。仅有 SID、PID 不代表手机 APP 转链权限已满足，具体授权类型以折淘客后台为准。
4. 小米粥「返利转链 → 淘宝 → 接入方式」选择「折淘客」，填写 AppKey、SID、完整 PID 和所需 RID 并保存。不需要淘宝应用 AppSecret；不会复用京东联盟 ID 作为淘宝授权。
5. 粘贴淘宝 APP 分享的整段文案，或淘宝／天猫商品链接、`e.tb.cn`／`m.tb.cn` 短链，执行测试。程序会自动提取链接并保留参数。没有 URL 的纯淘口令暂不支持。先核对推广链接和订单归因，再开启自动回复和群转发。

接口提供的商品名、淘口令、图片和预估佣金用于现有模板；发送图片仍由「附带商品图片」开关控制。缺失字段不补造，预估佣金不等于用户最终到账返利。切换回官方直连会保留折淘客参数；修改配置后需保存才用于实际转链。

#### 参数获取入口与排错（v0.3.10）

| 参数 | 在哪里获取 | 填写内容 |
| --- | --- | --- |
| 折淘客 AppKey | [淘宝板块对接秘钥](https://www.zhetaoke.com/user/open/open_appkey.aspx) | 登录后复制 AppKey；不填写淘宝应用 AppSecret或折京客密钥 |
| SID | [授权管理](https://www.zhetaoke.com/user/shouquan.html) | 完成淘宝账号授权，复制对应授权记录的 SID |
| PID | [淘宝联盟](https://pub.alimama.com/)的推广位管理；[折淘客 PID 管理](https://www.zhetaoke.com/user/extend/extend_mypid.aspx) | 复制完整 `mm_数字_数字_数字`；须属于 SID 对应账号，渠道场景使用渠道专属推广位 |
| RID | [渠道备案获取教程](https://www.zhetaoke.com/help_detail_3_20.html)、[渠道备案接口说明](https://www.zhetaoke.com/user/open/open_sc_publisher_save.aspx)、[渠道查询 API 文档](https://www.zhetaoke.com/user/open/open_sc_publisher_get.aspx) | 用户通过渠道邀请备案后取得的 `relation_id`；代理授权和手淘分享需要填写 |

RID 没有所有账号通用的领取链接。请先打开[淘宝联盟后台](https://pub.alimama.com/)，登录自己的账号，在渠道管理中获取自己的邀请备案链接，完成对应用户备案后取得 relation_id。没有渠道管理入口时，先向淘宝联盟确认渠道权限；不要使用教程中的示例邀请码。

这些入口需要自行登录，页面不会自动把小米粥中的密钥带到链接里。RID 教程和查询入口是说明页，不是打开就能产生 RID；须先满足渠道权限并完成用户备案。目前小米粥只有一个固定 RID 配置，所有转链共用它，尚未实现每个 QQ 用户自动备案和订单返利记账。

排错顺序：

1. 修改参数后点击保存；有未保存更改时测试按钮禁用。已配置只代表保存成功，不代表账号授权已验证。
2. 选择「基础转链」并保存，粘贴一条当前可推广商品的链接或完整分享文案测试。基础类型对应 `signurl=3`，不保证图片、淘口令或佣金金额；不要把佣金率当成金额。
3. 基础成功后再切换「简版商品详情与淘口令」（4）或「完整商品详情与淘口令」（5）。旧版的完整详情选项保持不变。三种类型都不能绕过账号授权或渠道权限。
4. 失败时查看结果里的错误码和说明，也可打开[折淘客在线测试](https://www.zhetaoke.com/user/open/test_open_gaoyongzhuanlian_tkl.aspx)，使用同一组参数、同一商品和同一结果类型作比较；在[折淘客调用日志](https://www.zhetaoke.com/user/open/open_log.aspx)核对请求。
5. 超时说明接口未及时返回，检查飞牛容器是否可访问 `api.zhetaoke.com:10001`。程序使用 HTTPS、POST 表单并编码一次，不自动降级为 HTTP。非 JSON 错误请检查是否被代理或登录页拦截。

如果折淘客在线测试也失败，先根据其错误处理授权、PID/RID 匹配或商品状态；若在线测试成功而小米粥失败，保留两边错误码和商品链接用于对照，无需把 AppKey 或其他密钥发到群里。

### 方式 B：淘宝官方直连

1. 登录[淘宝联盟](https://pub.alimama.com/)，确认推广者账号及媒体备案。按[官方新手指南](https://developer.alibaba.com/docs/doc.htm?articleId=118970&docType=1&treeId=713)，媒体备案审核通过后申请 AppKey，并在联盟开放平台创建与该媒体关联的应用，取得 AppKey、AppSecret。已有淘宝联盟推广账号但没有应用密钥时，需要先完成这一步。
2. 在联盟后台建立或找到用于这次投放的推广位及其 PID。PID 形如 `mm_第一段_第二段_第三段`；xiaomizhou 的「推广位 ID」只填**第三段数字**，不要填完整 PID。该 ID 应属于你自己的推广账号和备案媒体。
3. 检查应用是否能调用 `taobao.tbk.dg.general.link.convert`。官方文档说明，该接口的 `material_list` 可以接收链接或淘口令，但联盟推广链接转链与淘宝/天猫原始复制链接转链的权限有区别，后者可能需要邀约申请。申请权限时应明确说明要处理群成员粘贴的商品链接。
4. 在 xiaomizhou 后台进入「返利转链」→「淘宝」，填写 AppKey、AppSecret 和推广位 ID 并保存。先用一个淘宝/天猫商品的完整 URL 做「单链接测试」。拿到 HTTPS 推广链接后，核对目标商品、推广位和联盟订单归因。

淘宝接口说明：[万能转链 API 文档](https://developer.alibaba.com/docs/api.htm?apiId=65409)、[淘宝联盟 API 新手指南](https://developer.alibaba.com/docs/doc.htm?articleId=118970&docType=1&treeId=713)。文档页面标示 API 无需用户授权，并不代表应用自动拥有所有物料类型的转链权限。

## 三、接入 QQ 消息自动转链

需要使用的平台通过单链接测试后，再到「返利转链」页打开「收到商品链接时自动转链」。按需要启用「在来源会话回复推广链接」。若要把结果发到另一群，还需先在「个人 QQ」或「QQ 机器人」页完成消息接入，然后配置并启用「转发规则」。QQ 官方机器人只能处理开放平台允许的私聊和群内 @ 消息；要处理普通群消息，需使用已接入的个人 QQ 桥接器。当前程序仅识别消息中的京东、淘宝、拼多多等 URL；每条消息最多处理前五个已识别商品链接。

## 四、失败时怎么查

| 现象 | 优先检查 |
| --- | --- |
| 提示缺少 AppKey/AppSecret、站点 ID 或推广位 ID | 后台字段是否填错；淘宝只填 PID 第三段；京东网站/APP 模式需要真实站点 ID。 |
| 平台提示无权限或 403 | 应用与接口权限、媒体备案、淘宝复制链接权限；京东社交接口是否单独申请。 |
| 接口返回商品不可推广或没有推广链接 | 换一件确认参加联盟计划的商品测试；检查商品链接是否完整。 |
| 超时或 `fetch failed` | 从飞牛主机及 xiaomizhou 容器分别测试到 `router.jd.com` 或 `eco.taobao.com` 的出站网络。 |
| 页面仅显示 `Operation failed; check logs` | 打开「运行日志」，查看相同时间的 `server` 错误；分享错误文字时隐藏密钥及完整推广参数。 |
| 生成链接但没有佣金 | 核对媒体备案、推广位、商品是否可推广、联盟订单状态与平台归因规则；不要只凭链接能打开判断。 |

密钥明文保存在 xiaomizhou 本地数据库，管理员页面会直接显示 AppSecret 和 Client Secret；「下载数据库备份」也包含原始密钥，应妥善保管。未经你的联盟账号实测，程序的模拟接口测试无法保证真实转链权限或佣金归因。
