# 微信支付与支付宝网页支付接入

2026-11-05 按用户确认的价格接入微信支付 v3（小程序 JSAPI + H5 Native 扫码）与支付宝网页支付（电脑网站 `alipay.trade.page.pay`、手机网站 `alipay.trade.wap.pay`）：初级会员 ¥9.90/月，高级会员 ¥29.90/月；高级首次付费优惠价 ¥24.90/月，界面写“首充优惠”；仅首次付费可享，再次购买/升级按原价 ¥29.90 计算，不虚构“前 100 名”等与实际规则不符的稀缺数量。会员按一个自然月手动续费，不自动扣款。

代码已实现，但**没有服务器支付密钥时不启用**：微信或支付宝变量全部缺失时对应渠道不展示，`/billing/checkout` 返回 503 `PAYMENT_NOT_CONFIGURED`。真实扣款还须运营者配置商户参数、证书/密钥和回调地址，并完成小额真实支付验收。

## 金额与商品

| 方案 | 服务端价格 | 前端展示 | 周期 |
| --- | --- | --- | --- |
| 初级会员 `basic` | 990 分 | ¥9.90/月 | 一个自然月，手动续费 |
| 高级会员 `premium` | 2490 分（原价 2990 分） | ¥24.90/月（首次付费），原价 ¥29.90 划线展示；再次购买/升级按 ¥29.90 | 一个自然月，手动续费 |
| 初级升高级 | 高级价减初级价 | 升级补差价 | 支付成功后从当前到期日顺延一个自然月，原剩余时间保留 |

价格以服务端为准，客户端只传 `planId`；服务端重新报价、计算金额并写入订单。价格可由服务器环境变量覆盖，见下文。

## 支付流程

1. 用户在微信小程序内先登录已有邮箱账号，支付前调用 `/api/v1/auth/wechat/bind`：
   - 小程序 `uni.login` 取得一次性 code；
   - 服务端用 `WECHAT_PAY_APP_SECRET` 调微信 `sns/jscode2session` 换 `openid`；
   - 只把 `openid` 绑定到当前登录账号，不自动创建微信账号，也不合并其他账号；
   - 同一 `openid` 已绑定其他账号时返回 409，不得静默转移。
2. 前端请求 `/api/v1/billing/quote?planId=basic|premium` 获取服务端报价（新购、续费、预约续费或升级补差价）。续费报价返回预计生效和到期时间。
3. 前端生成至少 16 字符的幂等 `requestId`，调用 `/api/v1/billing/checkout` 并带 `channel`。服务端创建 `pending` 订单：小程序传 `jsapi`，调用微信支付 v3 JSAPI 下单并返回已签名的 `wx.requestPayment` 参数；H5 传 `native`，调用 v3 Native 下单，返回 `code_url` 与服务器生成的二维码 SVG data URL，由消费者用微信扫码。
   - 同一账号、同一 `requestId` 的重复请求复用同一订单，不会重复扣款；
   - 未过期的 `pending` 订单不会重复下单；
   - 不同 `requestId` 会创建新订单，前端不得复用旧订单号。
4. 小程序调起微信支付。前端 `success` 只代表微信客户端返回成功，**不能据此发放会员**。
5. 微信支付服务器向 `WECHAT_PAY_NOTIFY_URL` 发送异步通知。服务端必须：
   - 用微信支付平台公钥验证 `Wechatpay-Signature` 等响应头；
   - 用 API v3 密钥 AES-256-GCM 解密通知资源；
   - 校验 `mchid`、`appid`、订单 `out_trade_no`、金额、币种、支付人 `openid`；
   - 在用户会员账本中写入可信支付事件，`QuotaService.activateMembership` 按事件幂等发放；
   - 把订单标记为 `paid`；重复通知返回成功但不重复延长会员。
6. 前端轮询 `/api/v1/billing/orders/:id`，服务端显示 `paid` 后才刷新会员状态。首次支付结果可能延迟几秒，不能按客户端 toast 直接更新权益。

## 服务端实现

| 文件 | 作用 |
| --- | --- |
| `shared/payment.ts` | 订单、支付参数、报价、绑定结果等前后端类型 |
| `server/payment-config.ts` | 价格配置、`WECHAT_PAY_*` 环境变量解析和 PEM 校验 |
| `server/payment-storage.ts` | 订单持久化、2 小时过期、严格 schema |
| `server/wechat-pay.ts` | 微信支付 v3 商户签名、平台公钥验签、JSAPI/Native 下单、回调解密 |
| `server/wechat-identity.ts` | 小程序 code 换 `openid`，app secret 只在服务端使用 |
| `server/alipay.ts` | 支付宝 RSA2 签名、电脑/手机网站收银台 URL、异步通知验签与金额解析 |
| `server/payments.ts` | 报价、下单、幂等、查单、微信/支付宝回调入账 |
| `server/http.ts` | `/billing/quote`、`/billing/checkout`（`channel=jsapi/native/alipay-page/alipay-wap`）、`/billing/payment-methods`、`/billing/orders/:id`、`/billing/wechat/notify`、`/billing/alipay/notify`、`/auth/wechat/bind` |
| `tests/payment.test.ts` | 假网关的报价、下单、幂等、微信/支付宝回调验签后入账与重复通知测试 |

订单写入单进程 JSON 数据，`orders` 字段缺失时按空数组迁移。首次保存退款申请时数据格式至少为版本 4，发布价格需要版本 5，保存带报价确认标识的订单或预约续费记录需要版本 6。多实例运行前需将支付、退款和权益账本迁入事务存储。

后台发布价格后，`/plans` 和 `/billing/quote` 读取当前版本。新版客户端下单传 `expectedAmountCents` 与 `reviewId`，服务端在创建订单的同一次写入里重新核对。金额变化返回 `BILLING_PRICE_CHANGED`，续费日期或方案变化返回 `BILLING_PERIOD_CHANGED`，前端刷新报价后由用户重新确认。预约续费要求确认标识。重复下单使用原订单的金额，支付确认时续费按账本里的已付周期排定实际日期。测试服务使用独立账本和模拟支付渠道。

## 后台会员退款

已支付且能匹配会员开通记录的订单可由管理员全额退款。预览绑定订单、会员变化和操作人。确认后先持久化独立退款单号，再核对原支付交易和金额并调用原渠道。微信以验签、解密后的回调或验签查询确认结果，支付宝使用验签后的资金变动结果或按退款单号查询。超时重试沿用原退款单号。相关接口见 [微信支付退款开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4013071031)、[支付宝退款接口](https://aipay.alipay.com/docs/subscribe/api-list/other-basic-interfaces/alipay-trade-refund.html) 和 [支付宝退款查询接口](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/api-list/alipay-trade-fastpay-refund-query.html)。

渠道确认成功与撤销本单权益共享同一份本地退款状态。其他订单按原周期生效，已结算用量保留。后台对未决结果有限次自动查询，重启后从已保存退款单恢复查询。微信回调路径为 `/api/v1/billing/wechat/refund-notify`，使用现有微信支付回调域名。

首次保存退款后，回退须使用支持版本 4 及退款权益规则的程序。渠道退款结果和业务文件继续保留。发布验收使用隔离账本与模拟渠道，真实出款需要商户侧实单验收。

## 服务器配置

在 `/etc/resume-youfang/runtime.env`（权限 `0600`，不提交 Git）中增加：

```sh
WECHAT_PAY_APPID=wx7c30911964bf6fe7
WECHAT_PAY_APP_SECRET=<小程序 AppSecret，仅服务器可见>
WECHAT_PAY_MCHID=<微信支付商户号>
WECHAT_PAY_MERCHANT_SERIAL_NO=<商户 API 证书序列号>
WECHAT_PAY_PRIVATE_KEY_PATH=/etc/resume-youfang/wechat-pay/apiclient_key.pem
WECHAT_PAY_API_V3_KEY=<32 字节 APIv3 密钥>
WECHAT_PAY_PUBLIC_KEY_PATH=/etc/resume-youfang/wechat-pay/wechatpay_public_key.pem
WECHAT_PAY_PUBLIC_KEY_ID=<可选：微信支付公钥 ID>
WECHAT_PAY_NOTIFY_URL=https://www.youfangcv.site/api/v1/billing/wechat/notify
```

支付宝网页支付另需（同样只放服务器）：

```sh
ALIPAY_APP_ID=<支付宝开放平台应用 APPID>
ALIPAY_SELLER_ID=<可选：支付宝商户 PID，配置后回调会额外校验>
ALIPAY_PRIVATE_KEY_PATH=/etc/resume-youfang/alipay/app_private_key.pem
ALIPAY_PUBLIC_KEY_PATH=/etc/resume-youfang/alipay/alipay_public_key.pem
ALIPAY_NOTIFY_URL=https://www.youfangcv.site/api/v1/billing/alipay/notify
ALIPAY_RETURN_URL=https://www.youfangcv.site/
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
```

支付宝应用需在开放平台签约 **电脑网站支付** 与 **手机网站支付**，并配置应用公钥、支付宝公钥与授权回调地址。`ALIPAY_NOTIFY_URL` 必须是公网 HTTPS；应用私钥和支付宝公钥只放服务器受限目录。

注意：

- 商户 API 私钥、平台公钥、AppSecret、APIv3 密钥只能放在服务器权限受限的目录和 `0600` 文件中；不要发聊天、写日志、放进 `VITE_` 变量、静态目录或 Git。
- 回调地址必须是公网可访问的 HTTPS，且与当前小程序 AppID、商户号绑定；未完成备案或证书异常时微信回调无法到达。
- 配置完成后重启服务。可用 `/api/v1/plans` 检查价格，`/api/v1/membership` 的 `paymentAvailable` 应为 `true`。不要用“已配置”代替真实支付验收。
- 价格覆盖变量：`MEMBERSHIP_BASIC_PRICE_CENTS`、`MEMBERSHIP_PREMIUM_PRICE_CENTS`、`MEMBERSHIP_PREMIUM_LIST_PRICE_CENTS`、`MEMBERSHIP_PREMIUM_PROMOTION_LABEL`。修改价格会改变所有新订单报价，旧订单仍按创建时金额校验。

## 支付宝网页支付

H5 会员弹窗在支付宝已配置时显示“支付宝支付”按钮。前端按浏览器设备选择 `alipay-page`（桌面，`alipay.trade.page.pay` + `FAST_INSTANT_TRADE_PAY`）或 `alipay-wap`（移动浏览器，`alipay.trade.wap.pay` + `QUICK_WAP_WAY`），服务端签名后返回收银台 `redirectUrl`，浏览器跳转支付宝完成支付。

1. 前端调用 `/billing/checkout`，`channel` 为 `alipay-page` 或 `alipay-wap`，不要求绑定微信 openid。
2. 服务端复用同一套报价与订单幂等规则，创建 `pending` 订单，签名拼接收银台 URL 返回 `alipay.redirectUrl`。
3. 支付宝异步通知 `POST /api/v1/billing/alipay/notify`（`application/x-www-form-urlencoded`）：服务端用支付宝公钥 RSA2 验签，校验 `app_id`、可选 `seller_id`、`out_trade_no`、金额与交易状态；通过后调用 `QuotaService.activateMembership` 幂等入账，再标记订单 `paid`。通知必须返回纯文本 `success`，否则支付宝会重试；失败返回 `failure` 并只记录安全错误码。
4. 浏览器从支付宝返回站点后，前端用本地保存的待确认订单轮询 `/billing/orders/:id`，确认 `paid` 后刷新权益。不能以跳转返回页代替服务端回调到账。
5. 支付宝回调没有微信的 `openid` 支付人字段，因此不校验支付人 openid；其他金额、商户、订单归属校验保持一致。

## 平台限制

- 微信支付没有公开的沙箱环境，代码测试使用注入的假网关；真实支付只能用小额订单验收，并在验收后按需退款。
- iOS 小程序不允许用微信支付购买虚拟会员/虚拟服务。本项目在 iOS 端不展示可支付状态，提示用户使用 Android 或后续开放的方式；不能绕过平台规则。
- H5 端支持 **微信 Native 扫码** 与 **支付宝电脑/手机网站支付**；电脑网页优先，手机浏览器里微信扫码体验较差，支付宝手机网站支付会跳转支付宝 App 或网页收银台。未接公众号 JSAPI 网页支付。
- 支付宝网页支付需在开放平台签约电脑网站支付、手机网站支付；测试环境可使用支付宝沙箱，但本项目尚未配置沙箱，真实验收需商家账号。`ALIPAY_RETURN_URL` 只负责跳回站点，不能作为发放权益的依据。
- iOS 小程序端继续屏蔽虚拟会员购买；H5 扫码不受小程序 iOS 限制，但仍需遵守微信支付及平台规则。
- Native 支付需在商户平台开通产品；商户平台的“Native 支付回调链接”应填 `https://www.youfangcv.site/api/v1/billing/wechat/notify`，与 `WECHAT_PAY_NOTIFY_URL` 保持一致。
- 管理后台支持支付订单查询及全额退款。关单、账单下载和跨渠道账单对账列入后续工作。
- 当前为单进程 JSON 存储，不具备生产级并发/多实例一致性；真实支付前应按 AGENTS.md 的数据一致性要求迁移到持久化数据库并做事务与幂等验收。

## 验收

```sh
npm run type-check
npm test
npm run build:h5
npm run build:mp-weixin
```

`tests/payment.test.ts` 覆盖：服务端报价、未绑定微信拒绝下单、`requestId` 幂等复用、微信/支付宝回调入账、重复回调不重复延长、金额不符拒绝、支付宝 page/wap 下单与换渠道冲突。真实支付验收须另做：金额篡改、伪造通知验签失败、并发重复回调、小程序端到端支付、H5 微信扫码与支付宝网页端到端支付与到账查询；当前未做真实支付、微信真机或浏览器显示验证，页面效果由用户自行验收。
