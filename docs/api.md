# 项目 API 契约

## 工作台会员权限（2026-11-07）

`GET /api/v1/membership/workbench` 要求有效会话且不接受查询参数，返回 `WorkbenchAccess`：`{planId,expiresAt,features}`。服务端只从当前会话账号的持久化会员记录判断，须满足 `startsAt <= 当前服务端时间 < expiresAt`；没有记录、未生效或到期均返回 `planId: free`、`expiresAt: null` 及全部 `features: false`。读取记录失败返回 503 `WORKBENCH_ACCESS_UNAVAILABLE`，客户端显示重试，不将错误或加载状态判为免费身份。

| `features` 字段 | 所需有效会员 |
| --- | --- |
| `resumeOptimization` | 初级或高级 |
| `careerAssistant`、`companyJobs`、`recruitmentPortals`、`studyMaterials`、`applications` | 高级 |

H5 与微信工作台依据该响应显示锁态，点击提示所需等级并可进入“权益”。客户端自报会员、套餐选择、设备时间、额度百分比和支付返回结果均不授予权限。受限查询与写入在各自 API 再检查，权限不足为 403 `WORKBENCH_MEMBERSHIP_REQUIRED`。此规则替代此前登录账号共享工作台的测试安排；`/membership` 的 `preview` 和 `limitsEnforced: false` 不表示工作台全部开放。

本轮权限限制工作台入口；首页及“我的”的免费简历编辑、规则检查、已有报告、审核与确认应用、基础模板和导出保留。真实模型仍使用原有告知、服务端配置和 Token 周额度，不因本次工作台变更启用新的模型或支付配置。

## 工作台求职助手

`POST /api/v1/career/assistant` 要求有效会话及高级会员的 `careerAssistant` 权限，请求为 `{resumeId?,resumeRevision?,requirements,message,history?}`。选择简历时必须同时提供 ID 和修订号；服务端从本人资料读取正文，检查版本并返回输入 hash 与有限的文本依据，不能由客户端传入另一人的正文或会员身份。对话历史仅用于本次请求，不写入简历或账号数据库。

响应 `engine: local-rules`，包含文字回答、识别的查询条件、未能核验的要求、最多 5 条企业历史资料及最多 5 条本人目标岗位。多轮对话可调整地区等已支持条件；薪资、当前在招等没有数据支撑的要求明确保留为待核对，不给招聘匹配率。空库、损坏目录、过期简历和无匹配分别处理，不静默放宽条件制造结果。修改请求只返回版本绑定的 `analyze-resume` 操作，用户点击后调用原诊断流程，再逐条审核与确认应用；助手接口本身不修改任何简历，不调用真实模型。

## 企业资料查询

`GET /api/v1/career/companies` 与 `GET /api/v1/career/companies/:id` 均要求服务端有效会话及高级会员的 `companyJobs` 权限。列表响应保留兼容字段 `access: authenticated-test`，该历史字段不授予测试共享权限；实际访问由服务端有效会员记录校验。客户端不能自报身份、数据文件路径或会员等级。没有普通用户可调用的企业目录写入接口。

列表参数：`q`（最多 200 字、20 个空格分隔关键词）、`page`（默认 1）、`pageSize`（默认 20，上限 50）、`sort`（`relevance / name / updated`）。多选筛选使用重复参数：`industries`、`natures`、`locations`、`directions`、`educationLevels`、`recruitmentTypes`、`cohorts`，每维最多 30 项。关键词之间 AND，同维度 OR，不同维度 AND；企业全称/别名优先，企业性质关键词的同义词扩展仅作用于企业性质原文，不按名称猜测。未知参数、重复标量、非法分页或外部身份声明返回 400。

返回 `CompanySearchResult` 包含目录状态/版本、分页/总数、`items` 及 `facets`；每个命中项返回经整理的企业资料字段与 `matchedFields`。统计单位是资料记录，不是工商主体数。某一维度的 facet 数量计算时忽略该维度自身选择，保留关键词和其他维度，以支持继续多选；其数量可能大于当前总数。`updated` 指本项目整理时间，不是招聘发布时间。详情返回 `CompanyRecord`，不包含原始文件路径、私人联系人、账号信息或导入审核原件；来源平台名称与链接不进入响应。

缺失文件返回 `catalogState: empty`，损坏文件返回 `unavailable`，不伪装成正常无结果；详情在损坏时为 503 `COMPANY_CATALOG_UNAVAILABLE`，不存在为 404。正常目录无匹配结果仍为 `ready` 且 `total: 0`。目录每次替换后按可信路径与文件签名刷新缓存，所有读取均经过运行时校验。企业资料与实际岗位分开，不能从企业记录直接建立投递计划。字段、数据位置及整理边界见 [企业资料库](company-library.md)。

开发服务默认监听 `http://127.0.0.1:3001`，H5 通过 Vite `/api` 代理访问；服务器由 Nginx 提供同源 HTTPS 反向代理。所有成功响应为 `{ "data": ... }`，错误为 `{ "error": { "code": "...", "message": "..." } }`。共享类型见 `shared/types.ts`、`shared/auth.ts` 与 `shared/workbench.ts`。当前实现账号、服务端会话、业务资源用户归属及工作台会员检查；支付代码已接入，但实际可用性取决于服务端配置及独立验收。仍使用单进程 JSON 存储，尚未迁移 MySQL 或完成生产能力验收。

## 认证与会话

| 方法 | 路径（前缀 `/api/v1`） | 请求 / 返回 |
| --- | --- | --- |
| GET | `/auth/providers` | `{emailPassword:true,wechat,phone,emailVerification,passwordReset}`；`phone` 与邮件能力字段由实际服务端配置决定；`wechat` 为 `true` 时可使用微信静默免登与微信绑定 |
| POST | `/auth/register` | `{email,password,challengeId?,code?}` → 201 + 会话；邮件启用时必须通过注册验证码，成功后自动登录 |
| POST | `/auth/login` | `{email,password}` → 200 + 会话 |
| GET | `/auth/me` | 返回当前会话的 `{user,expiresAt}`；无有效会话时 401 |
| POST | `/auth/logout` | 撤销当前会话并清除 Cookie，返回 `{signedOut:true}` |
| POST | `/auth/email/code` | `{email,purpose,replace?}`，用途为 `register / reset-password / verify-email / bind-email` → 202 + `{challengeId,expiresAt,resendAfterSeconds,message}`。验证本人邮箱与绑定新邮箱需会话。仅在换绑时给新邮箱的 `bind-email` 请求传 `replace:true` |
| POST | `/auth/email/verify` | `{challengeId,code}`，要求有效会话，验证成功返回更新后的 `AuthUser` |
| POST | `/auth/password/reset` | `{email,password,challengeId,code}` → `{passwordReset:true}`；仅支持已验证邮箱账号，不自动登录，并撤销全部旧会话 |
| POST | `/auth/password/change` | `{currentPassword,newPassword}` → `{passwordChanged:true}`。需有效会话，修改后撤销全部会话 |
| POST | `/auth/wechat` | 小程序静默免登：`{code}` → 按 openid 查找/创建账号并返回会话；未配置微信凭据时 501 `WECHAT_LOGIN_NOT_CONFIGURED` |
| POST | `/auth/phone/code` | `{phone,purpose,replace?}` → 202 + 挑战。用途为 `login / bind-phone / verify-account`，后两者需会话。仅在换绑时给新号码的 `bind-phone` 请求传 `replace:true` |
| POST | `/auth/phone` | `{phone,challengeId,code}` → 200 + 会话；号码未绑定则在验证码验证后创建独立手机号账号 |
| POST | `/auth/phone/bind` | 已设密码的账号提交 `{phone,challengeId,code}`，无密码账号另提供当前身份凭证；需有效会话，返回本人 `AuthUser` |
| POST | `/auth/email/bind` | `{email,challengeId,code,currentPassword?}` 或当前手机证明；无密码账号另需新 `password`；需会话 |
| POST | `/auth/phone/change`、`/auth/email/change` | 新手机号或邮箱、目标 `challengeId` 和 `code`、原联系方式的 `currentChallengeId` 和 `currentCode`。需会话，返回本人 `AuthUser` |

`user` 只包含公开账号字段 `{id,email?,phone?,emailVerified,phoneVerified?,hasPassword?,createdAt}`，不包含密码哈希或会话哈希。邮箱会去除两端空白并转小写，最多 254 字符；新密码为 6–16 位，只能使用字母、数字和符号，不能包含空格、中文或控制字符。登录仍接受 6–128 位不含控制字符的旧密码，密码不自动去除空白。请求须经过服务端字段白名单、类型及长度校验，不能仅凭客户端类型信任输入；注册与登录有频率和密码计算并发限制。

H5 使用名为 `youfang_session` 的 HttpOnly、SameSite=Lax Cookie，生产环境启用 Secure；H5 注册和登录响应不返回原始令牌。小程序在注册或登录请求中声明 `X-Auth-Client: mp-weixin`，服务端才在会话响应中附加 `token`；后续发送 `Authorization: Bearer <token>`。此请求头只选择会话传输方式，不授予微信身份、会员或额外权限。会话绝对有效期为 7 天，退出后撤销，重启服务后仍以持久化会话状态验证。服务端只保存随机令牌的 SHA-256 哈希。

`/health`、`/plans` 与认证入口允许未登录访问；`/membership`、`/membership/quota`、`/membership/workbench`、账单预览以及所有简历、报告、诊断任务和建议应用接口要求有效会话。所有资源查询与修改均从可信会话确定用户，不能通过客户端提交 `userId` 越权；请求其他用户资源按不存在返回 404。不同用户的草稿与工作空间缓存也分别保存。

H5 通过同源接口访问，Cookie 写请求需要来源校验。部署通过 `AUTH_TRUSTED_ORIGINS` 配置精确来源列表，不把客户端传入的 Host 或转发头视为授权；小程序 Bearer 通道不依赖浏览器 Cookie。`AUTH_SECURE_COOKIES` 控制 Cookie 的 Secure 属性，默认随 `NODE_ENV=production` 启用，公网 HTTPS 不应关闭。

`emailVerified` 仅在完成邮箱证明后为 `true`。旧账号保留原状态，缺省为 `false`，必须先凭原密码登录后完成本人邮箱验证，才能使用找回密码；找回流程不用于认领或提升未验证的旧账号。客户端提交 `emailVerified` 不能授予验证状态。微信小程序静默免登按 openid 建立账号，已有邮箱/手机账号不会自动合并；微信授权手机号与短信验证码分别开放，是否启用看 wechatPhone 与 phone。短信验证码登录、注册和绑定已接入代码，是否可用由 `phone` 能力字段与真实配置决定，关闭时返回 `SMS_NOT_CONFIGURED`，不返回假验证码或登录成功。

## 手机号验证码与绑定

当前短信提供方为腾讯云，默认关闭；尚无已确认的短信应用 SDKAppID、审核通过签名名和模板 ID。本轮代码发布不写入真实短信配置、不使用聊天密钥、不发真实短信。`phone:true` 仅表示服务端已启用并通过配置校验，不等于供应商权限、余额或最终收件已验证。配置、请求及费用边界见 [手机号与短信](phone-auth.md)。

手机号登录只接受号码、随机挑战 ID 和六位验证码，不信任客户端传入的 `userId`、验证状态或会员身份。已绑定号码登录原账号；未绑定号码验证后原子创建 phone-only 账号，不生成假邮箱或默认密码。新绑定只增加当前账号登录标识，保持原账号 ID、简历、会员与会话范围；目标标识属于其他账号时拒绝，不自动合并。

绑定要求有效会话与目标 `bind-phone / bind-email` 验证码。已设密码的账号首次绑定手机号时，由服务端以有效会话确认当前身份。需要核验其他身份凭证时，已设密码的账号使用 `currentPassword`，仅有手机号的账号使用当前手机号的 `verify-account` 验证码，无密码的微信账号可用 `wechatCode` 核对当前 OpenID。无密码账号绑定邮箱还须设置合规新密码。用途、目标、挑战 ID 与用户均须匹配，登录码不能作绑定码。

换绑时，原手机号使用 `verify-account`，原邮箱使用 `verify-email`。两端验证码在同一次账号更新中校验。成功后原联系方式失效，旧验证码不能继续用于登录或找回密码，当前会话保留，其他会话撤销。

短信验证码有效 5 分钟、60 秒冷却、最多 5 次错误。发送先持久化预占，供应商确认提交后才有效；失败也计入发送限额，不自动重试。默认单号 5 条/小时、10 条/24 小时，单 IP 标签 10 条/小时、30 条/24 小时，全服务 100 次/24 小时、2 并发。验证码只保存 HMAC，不进入响应或日志。供应商接受不证明最终送达，本地超时也不证明没有计费。

## 邮箱验证码与密码找回

验证码为 6 位随机数字，有效期 10 分钟，重发间隔 60 秒，最多允许 5 次错误。挑战绑定邮箱、用途与随机 `challengeId`；注册、重置密码、已有账号验证和新邮箱绑定不能相互使用；`bind-email` 另绑定当前用户。服务端仅保存 HMAC 哈希，密钥来自独立的 `MAIL_CODE_SECRET`；明文验证码只传给发信器，不能出现在 API 响应或日志中。

发码先持久化 `pending` 预占记录，SMTP 接受后才可标记为可用；发送失败保留失败状态并返回明确错误，不能拿未成功发送的挑战注册或重置密码。新的同用途验证码成功发送后，旧的未消费验证码失效；新邮件发送失败不将旧的有效验证码误消耗。冷却、邮箱与客户端发送频率限制受服务端控制，不依赖前端倒计时，客户端来源只保存不可逆标签。

`reset-password` 发码对所有合法邮箱采用一致的请求和响应流程，不在发码时暴露是否已注册或已验证。最终密码重置必须校验有效、未消费的重置挑战及账号已验证状态；密码哈希更新、全部旧会话撤销及关联挑战失效在同一次持久化修改中完成。未知或未验证账号在确认阶段统一返回 `CODE_INVALID_OR_EXPIRED`，不修改密码、验证状态或会话，也不能得到虚假的重置成功。验证码错误次数会持久化，不能因事务报错回滚而无限尝试；并发消费仅允许一个请求成功。

生产服务要求注册验证码，邮件关闭、缺少配置或发送失败时不降级为免验证码注册。本机未启用邮件的开发演示模式可保留邮箱密码注册，但不会标记邮箱已验证。SMTP 接受表示邮件已提交到发信服务，不保证已经投递到收件箱。

## 接口

| 方法 | 路径（前缀 `/api/v1`） | 请求 / 返回 |
| --- | --- | --- |
| GET | `/health` | 返回 `status: ok`、`analysisEngine: rules / bailian`、`aiConfigured`（本地配置是否启用，非可用性检测）、可选 `model`、`persistence: local-json` |
| GET | `/membership` | 返回 `MembershipState`：无可信会员时为免费 `preview`，有效可信会员为 `active`；包含当前方案、由服务器支付配置决定的 `paymentAvailable`、`policy` 和仅百分比的 `quota` |
| GET | `/membership/quota` | 返回本人 `AiQuotaSummary`：`{status,remainingPercent,resetsAt,expiresAt,pending}`；不返回绝对 Token 或单次消耗 |
| GET | `/membership/workbench` | 返回 `WorkbenchAccess`：`{planId,expiresAt,features}`，仅服务端当前有效会员记录授予相应工作台权限；无效会话为 401，不接受查询参数 |
| GET | `/plans` | 返回 `free / basic / premium` 三档权益与服务器价格（分）；未配置支付时 `paymentAvailable` 为 false，价格仍返回当前服务端配置 |
| GET | `/billing/quote?planId=` | 返回 `MembershipQuote`：金额、`purchase/renewal/upgrade/scheduled`、当前方案、确认标识及可选 `virtualProductAvailable`。升级补差价由服务端计算 |
| GET | `/billing/payment-methods` | 公开，返回 `{wechat:boolean,alipay:boolean}`。小程序请求在虚拟支付启用后还返回 `wechatVirtual:{ios:boolean}` |
| POST | `/billing/checkout` | 创建或复用本人订单。网页使用 `native` / `alipay-page` / `alipay-wap`；旧 `jsapi` 订单沿用 v3 处理。小程序 `wechat-virtual` 还须提供 `expectedAmountCents,reviewId,wechatCode,device`（`ios 或 other`），返回订单与微信签名参数。渠道启用、价格、商品与报价均由服务端核对。同一幂等键换方案、金额、报价或设备类型返回 409 |
| GET | `/billing/orders/:id` | 返回本人订单摘要。虚拟支付订单可触发限频的服务端查单和到账核验。其他账号订单返回 404 |
| POST | `/billing/wechat/notify` | 微信支付 v3 异步通知入口，公开但必须通过平台公钥验签；处理成功返回 `{code:'SUCCESS'}`，失败返回错误且不发放会员 |
| POST | `/billing/alipay/notify` | 支付宝异步通知入口，公开但必须通过 RSA2 验签；校验 app_id/seller_id/订单/金额后入账，成功返回纯文本 `success`，失败返回 `failure` 且不发放会员 |
| GET / POST | `/billing/wechat-virtual/notify` | 微信后台消息推送。GET 校验配置挑战，POST 验签解密安全模式 JSON 通知；通过核对才发放或撤销对应权益 |
| POST | `/auth/wechat/phone/bind` | `{wechatCode,phoneCode}` → 同一账号的 `AuthUser`。需要会话和已配置的微信手机号实时验证。OpenID 不匹配或号码已属于其他账号时拒绝 |
| PUT | `/auth/profile` | `{nickname,avatar?}` → 本人 `AuthUser`。昵称可传 null 清空；头像为最多 128 KB 的 JPG/PNG Base64，省略保留，null 移除 |
| GET | `/auth/profile/avatar/:id` | 当前会话本人的头像二进制，私有响应。其他账号和已移除图片返回 404 |
| POST | `/auth/wechat/bind` | `{code}` → `{bound:true,openidMasked}`；服务端用小程序 code 换 openid 并绑定当前账号，绑定其他账号返回 409 |
| GET | `/resumes` | 返回本人简历数组，按更新时间倒序 |
| POST | `/resumes` | `{title, targetRole?, text}` → 201 + 归属当前会话用户的简历 |
| GET | `/resumes/:id` | 返回本人简历 |
| PUT / PATCH | `/resumes/:id` | `{title?, targetRole?, text?, revision}` → 修改后简历；必须提供当前修订号，PUT 为兼容小程序，和 PATCH 使用相同的部分更新语义 |
| DELETE | `/resumes/:id` | 删除简历、全部历史版本、恢复幂等记录及关联诊断和投递计划，返回 `{deleted:true,id}` |
| GET | `/resumes/:id/versions` | 返回本人该简历的 `ResumeVersionSummary[]`，按修订号倒序；摘要不含历史正文 |
| GET | `/resumes/:id/versions/:revision` | 返回完整 `ResumeVersion`，包括当时保存的 `snapshot`、来源、内容 hash 和时间 |
| POST | `/resumes/:id/versions/:revision/restore` | `{revision,confirmed,idempotencyKey}` → `{resume,restoredFromRevision,alreadyRestored,noChange}`；路径为历史修订号，请求体为当前修订号 |
| POST | `/resumes/:id/export` | `{revision, format: "docx" \| "pdf", template: "minimal" \| "modern" \| "business"}` → 200 + `ResumeExportFile`：`{revision, format, template, resumeId, fileName, mimeType, contentBase64}`；正文由服务端读取，文件上限 8 MB |
| POST | `/resume-imports` | `{fileName,size}` → 201 + `{id}`；创建归属当前会话账号的临时导入 |
| PUT | `/resume-imports/:id/chunks` | `{offset,contentBase64}` → `{uploadedBytes}`；按顺序上传 180 KiB 分段，末段可更短，相同分段可重传 |
| POST | `/resume-imports/:id/parse` | 上传完整后返回 `{fileName,format,text,pageCount?}`，供用户核对与编辑 |
| DELETE | `/resume-imports/:id` | 取消上传或解析并清理会话 |
| POST | `/analyses` | 接收同下方任务的输入，规则模式同步诊断；启用百炼时返回 `USE_ANALYSIS_JOB` |
| POST | `/analysis-jobs` | `{resumeId, resumeRevision?, jobDescription?, targetRole?, aiConsent?, idempotencyKey?}` → 202 + 持久化任务；百炼模式必须 `aiConsent: true`，有效会员的真实模型请求还必须带修订号及幂等键 |
| GET | `/analysis-jobs/:id` | `queued / running / completed / failed / cancelled`；成功后含 `analysisId`，失败含安全错误 |
| DELETE | `/analysis-jobs/:id` | 请求取消，运行中由执行路径确认；已经提交持久化的任务可能返回 completed |
| GET | `/analyses/:id` | 返回本人诊断报告 |
| GET | `/resumes/:id/analyses` | 返回本人该简历的诊断历史 |
| POST | `/analyses/:id/suggestions/:suggestionId/apply` | `{confirmed?, replacement?, revision}` → `{resume,analysis,alreadyApplied}` |

诊断输入可选的 `resumeRevision` 是本次预期的已保存版本，提供时须为正整数；同步诊断、任务入队及执行前均检查，过期返回 `REVISION_CONFLICT`，不会调用 provider 或写入报告。规则及无会员记录的演示请求仍兼容旧客户端省略修订号；有效会员的真实模型请求缺少 `resumeRevision` 或 `idempotencyKey` 返回 400 `ANALYSIS_REQUEST_GUARD_REQUIRED`。现有客户端的真实模型请求始终携带当前保存版本和账号隔离的幂等键；提交响应不明时复用键，已知任务 ID 时直接恢复查询。

`revision` 从 1 开始。正文、名称或目标岗位实际改变时递增；完全相同的更新不递增。编辑和采用建议必须携带读取时的 `revision`，缺失返回 400，版本不匹配返回 409，避免覆盖新内容。已经采用的同一建议可携带原修订号重试，仍返回 `alreadyApplied: true`，不会重复修改。报告中的 `resumeRevision` 表示诊断所依据的版本，`inputSnapshot` 固定当时的正文、目标岗位和 JD，`inputHash` 为此快照的 SHA-256；采用建议会更新简历，报告分数仍属于原版本，需重新诊断获取新分数。

## 简历版本与恢复

创建、实际编辑、采用建议和恢复历史内容时，在同一次单进程原子持久化中保存不可变的简历快照；来源分别为 `created / edited / suggestion / restored`。快照固定简历名称、目标岗位、正文、原修订号及时间；`contentHash` 是名称、岗位和正文的 SHA-256，不把单独的正文 hash 误当作全部内容的身份。列表只返回摘要，点击记录后再读取该条正文。所有读取、恢复和删除都从可信会话核对本人归属。

旧 JSON 不含版本记录时，只把当前已知正文及原修订号保留为 `baseline`（历史记录起点），不会推造更早的版本。仍使用版本 3 JSON，新增 `resumeVersions / resumeRestores` 字段，未迁移至 MySQL。更新前保留受限备份；旧程序不能保证继续记录后续修改的历史，回退前应检查兼容性。

恢复前应展示当前与历史的名称、目标岗位和完整正文，用户核对真实内容后明确提交 `confirmed: true`。请求体 `revision` 必须等于当前保存版本，`idempotencyKey` 为 8–100 位字母、数字、下划线或短横线。名称、岗位或正文有差异时，恢复产生当前修订号加一的新快照并记录 `restoredFromRevision`，保留所有历史记录；内容全部相同时返回 `noChange: true`，不新增修订。存在待补事实占位符的历史正文不能直接恢复，须在编辑器中补充真实内容再保存。恢复后的旧分析不能覆盖新版本，需重新诊断。

同一用户、简历和幂等键的重复请求返回原恢复结果并标记 `alreadyRestored: true`；即使此后又有修改，也不会再次覆盖当前内容。同一键搭配不同历史修订号或当前修订号返回 409 `IDEMPOTENCY_CONFLICT`，持久化记录包含确认时间、来源版本、提交时版本及恢复结果。网络结果不明确时客户端保留原键重试；重新选择、重新读取和版本冲突后要求再次审核。当前设备草稿按账号保留，历史恢复不删除或重写未保存草稿，随后保存旧草稿仍受修订号检查。退出或切换账号销毁历史阅读状态，不缓存其他账号正文。

规则模式使用正文、岗位及当前词库，`engine` 返回 `rules`。核心模块、成果证据、职责表达、岗位关键词均从提交文本计算。分数只用于相同规则下比较改动，不是招聘评分或录用概率。填写 JD 时以 JD 中识别到的能力为匹配依据；没有匹配词时使用中性维度分，不伪造匹配结论。

## 导出文件

`POST /resumes/:id/export` 使用已保存的简历正文和选定版式生成 Word（`.docx`）或 PDF 文件，正文由服务端读取，客户端不能另外提交正文。`revision` 必须等于当前保存版本，否则返回 409 `REVISION_CONFLICT`；生成前后各校验一次，避免导出过期内容。服务端同一时间只处理一个导出，已有任务时返回 429 `EXPORT_BUSY`；单次导出超过 20 秒返回 504 `EXPORT_TIMEOUT`，客户端断开或请求取消返回 409 `EXPORT_CANCELLED`，生成文件超过 8 MB 返回 413 `EXPORT_TOO_LARGE`，渲染失败返回 502 `EXPORT_RENDER_FAILED`。成功返回 JSON 中的 `contentBase64`，不是二进制响应；H5 将 base64 转成 Blob 触发浏览器下载，微信小程序写入本地文件后调用 `openDocument` 打开，两端业务内容一致。导出不修改简历正文或修订号。

## 采用建议

涉及经历补充的建议带有 `needsConfirmation: true`。客户端应展示 `original / replacement / reason`，要求用户填写 `[请填写真实…]`，点击“确认并采纳”时提交 `confirmed: true` 与核实后的 `replacement`。未确认或未填完占位符返回 400。系统不会自行生成业绩数字。

服务在一次原子持久化中修改正文和建议状态。相同建议重复提交返回 `alreadyApplied: true`，不重复写入；重复请求携带另一段替换内容返回 409。建议原文不在正文、重复出现或诊断后有其他编辑，均返回 409。允许同一报告中的不同建议依次采用。编辑后应重新诊断。

## 限制与错误

请求体上限 256 KB；简历正文 50,000 字符；JD 15,000 字符；简历名称及目标岗位各 120 字符；单条修改文本 20,000 字符。字符串统一换行并移除首尾空白，不接受空正文、空名称、未知字段及错误类型。写入使用 `application/json`。微信导入支持最多 10 MB 的 DOCX 或 PDF，PDF 上限 50 页。上传会话 3 分钟过期，服务端每次只解析一份文件，单次解析最长 20 秒。导出接口只接收版本、格式和版式，正文由服务端从已保存简历读取，文件以 JSON 中的 `contentBase64` 返回。

| HTTP | 常见 code | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | 字段或 JSON 无效 |
| 400 | `CONFIRMATION_REQUIRED` / `PLACEHOLDERS_UNRESOLVED` | 建议尚未核实或占位未填 |
| 401 | `AUTH_REQUIRED` / `INVALID_CREDENTIALS` | 会话缺失或过期、邮箱密码不匹配 |
| 403 | `ORIGIN_NOT_ALLOWED` | Cookie 写请求来源未获授权 |
| 403 | `MEMBERSHIP_EXPIRED` | 会员已到期，拒绝新的真实模型调用 |
| 403 | `WORKBENCH_MEMBERSHIP_REQUIRED` | 工作台查询或写入需要有效初级／高级会员，具体等级由功能决定 |
| 400 | `ANALYSIS_REQUEST_GUARD_REQUIRED` | 有效会员的模型请求缺少修订号或幂等键 |
| 404 | `NOT_FOUND` | 接口、简历、报告或建议不存在，或不属于当前用户 |
| 405 | `METHOD_NOT_ALLOWED` | 请求方法不支持 |
| 409 | `EMAIL_ALREADY_REGISTERED` | 邮箱已注册 |
| 409 | `PHONE_ALREADY_BOUND` / `EMAIL_ALREADY_BOUND` | 标识已属于其他账号，拒绝直接绑定或自动合并 |
| 401 | `CURRENT_IDENTITY_REQUIRED` / `CURRENT_IDENTITY_INVALID` | 绑定所需当前身份证明缺失或不正确；不等于登录会话已过期 |
| 409 | `REVISION_CONFLICT` / `SOURCE_CONFLICT` | 版本已变化 |
| 409 | `SOURCE_MISMATCH` / `AMBIGUOUS_SOURCE` / `ALREADY_APPLIED` | 原文冲突或重复请求不一致 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一历史恢复或诊断请求标识携带了不同输入 |
| 409 | `EXPORT_CANCELLED` | 导出请求被取消（客户端断开或服务停止） |
| 413 | `PAYLOAD_TOO_LARGE` | 请求过大 |
| 413 | `EXPORT_TOO_LARGE` | 生成文件超过 8 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 不是 JSON 请求 |
| 429 | `AUTH_RATE_LIMITED` / `AUTH_BUSY` | 认证请求过频或密码计算并发已满 |
| 429 | `EXPORT_BUSY` | 已有导出任务正在生成 |
| 429 | `AI_QUOTA_EXHAUSTED` | 本周余额不足以覆盖模型预占，不再派发 |
| 429 | `QUOTA_TASK_PENDING` | 本人已有调用处理中或用量待核对，暂不能派发新调用 |
| 500 | `INTERNAL_ERROR` | 本地存储或内部服务失败，详细信息仅服务日志可见 |
| 501 | `WECHAT_LOGIN_NOT_CONFIGURED` | 服务端未配置微信登录凭据 |
| 502 | `EXPORT_RENDER_FAILED` | 文件渲染失败或生成结果无效 |
| 503 | `MAIL_NOT_CONFIGURED` / `MAIL_DELIVERY_FAILED` | 邮件服务未配置或发送未成功，不能视为验证码已发送 |
| 503 | `SMS_NOT_CONFIGURED` / `SMS_DELIVERY_FAILED` | 短信未启用或提交未获确认，不能视为已送达或验证码可用 |
| 503 | `WORKBENCH_ACCESS_UNAVAILABLE` | 服务端暂时无法查询工作台会员记录，不能据此判断账号为免费 |
| 429 | `SMS_RATE_LIMITED` / `SMS_BUSY` / `CODE_RESEND_TOO_SOON` | 短信发送限额、在途并发或冷却限制 |
| 504 | `EXPORT_TIMEOUT` | 导出超过 20 秒未完成 |

账号、会话、简历、报告、邮件和短信挑战、诊断任务、可信会员事件与模型用量账本落盘到 `.data/resumes.json` 的版本 3 格式，采用临时文件 + rename 原子提交，写入权限为当前用户可读写；密码使用 scrypt 哈希，不保存明文密码。兼容迁移保留版本 1 的旧无主简历与报告隔离，不自动分配给第一位注册账号；版本 2 的账号、会话及业务归属继续保留，旧邮箱验证状态不会被擅自提升。此存储仅支持单进程，不是生产数据库；文件解析文本和账号邮箱可能包含个人信息，请按真实业务需要配置保留与删除策略，备份不得提交 Git。

## 权益与充值预览

权益页使用 `free / basic / premium` 三档：免费体验保留基础模板和首页规则闭环；初级及高级开放工作台简历优化入口；高级再开放求职助手、按专业分类的公司和岗位信息、招聘入口、复习资料、投递计划与手动进度记录。具体锁态由 `/membership/workbench` 决定。工作台默认包含覆盖现有 16 个专业的应届生准备材料和官方招聘入口；入口不等同在招岗位，当前没有自动执行投递。会员权益、价格和周期由服务端返回，客户端不能自行授予身份。已确定金额使用整数分；付费 `priceCents: null` 表示待定价，不能按零元商品处理。AI 周额度已采用实际输入加输出 Token 结算，后台试运行上限为初级 200,000、高级 800,000 Token；公共响应只提供剩余百分比，不使用固定次数或点数。详情见 [AI 周额度](ai-quota.md)。

`membership.policy` 描述一个自然月、手动续费、上海时区及初级升高级的补差价和周期重置规则。有效初级升级时应补高级月价减初级月价；服务端确认支付成功后立即生效，在原到期日基础上顺延一个自然月，原剩余天数保留。月末无对应日期时取次月月底同一时刻；已过期按高级新购。同档有效会员续费从原到期时刻延长一个自然月，过期后从确认付款时刻起算。详见 [会员机制](membership.md)。这些是本项目产品规则，不是对其他平台退款、抵扣政策的承诺。

`AiQuotaSummary.status` 为 `preview / active / inactive`。仅 `active` 带 0–100 的整数 `remainingPercent` 与 ISO 时区时间；百分比按已确认实际用量计算并向上取整，正余额不会被舍入为 0%。`pending` 表示尚有处理或用量核对，预占不作为实际扣减展示；百分比大于零不保证可以绕过在途任务或保守预占检查。周起点来自首次可信激活，每 7 天刷新；`resetsAt` 到会员末期截断为 `expiresAt`，此时界面显示额度有效至而非承诺续期刷新。续费和升级保持周起点，升级保留本周消耗后换用高级总量。

`/billing/checkout` 只接受服务端定义的字段：`planId`、至少 16 字符的幂等 `requestId`，以及可选 `channel`（`jsapi`/`native`/`alipay-page`/`alipay-wap`）。旧档位、无效方案、免费方案、客户端提交的价格/会员等级/有效期/支付结果字段返回 400；未配置对应支付渠道返回 503 `PAYMENT_NOT_CONFIGURED`，不会扣费或发放会员。`paymentAvailable` 由服务器支付配置决定；默认没有可信会员记录时仍为免费预览。订单状态以服务端异步通知和会员账本为准，客户端 toast、跳转返回页或 `order.status` 单独都不能作为发放权益的依据。内部 `activateMembership` 仅供已验证支付适配器和受信测试调用，不是用户可调用的 HTTP 授予接口。

## 百炼诊断

`engine: bailian` 表示真实模型建议通过结构及来源校验；`modelRun` 固定模型名、提示词版本、工作流版本、温度、输出上限、脱敏输入 hash、告知版本与确认记录，`knowledgeScope: public-role-guides` 与 `knowledgeReferences` 记录实际发送的原创岗位卡版本，未检索到卡片时为 `none`。新报告可附 `roleGuide`、`workflowVersion` 和 `jobReview`。后者按规则展示最多 10 条 JD 原文、条件类别与对应词语的简历片段，其他条数由 `omitted` 表示。报告中的 `guideReference` 仅能引用本次发送的卡片。参考分、维度和关键词仍来自规则基线，前端分别标注，不将文本覆盖包装为实际能力。

任务受限为单进程全局单并发，任务 ID、输入快照、修订号、输入/请求 hash、模型与工作流配置和幂等键持久化到 `analysisTasks`；不是多实例生产任务队列。同一用户、同一幂等键和相同输入返回原任务，不再次调用模型；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。进程启动将旧 `queued / running` 任务标为 `failed`、错误码 `JOB_INTERRUPTED`，保留 ID，不自动重放。尚未发送的额度预占释放；已发送但没有实际用量的记录转为 `pending`。

输入绑定提交时简历修订号，生成期间或保存前修改会拒绝写报告；取消在报告持久化提交前生效。模型响应中的实际输入/输出 Token 在内容校验前结算，因此失败、超时、取消、版本冲突或保存失败不撤销已发生的用量；尚未派发的失败不扣减。已派发而没有有效供应商 `usage` 时保留待核对，阻止该用户新模型请求；不能按字数或失败状态估算扣减。完成报告也不保证用量已结算，缺失 `usage` 的成功报告仍可能伴随 `pending`。GET 报告、确认应用、导出及本地规则不消耗模型额度。

服务端模型超时 45 秒、自动重试次数 0、输出最多 4,000 tokens、响应最多 96 KB、脱敏输入 JSON 最多 20,000 字符。客户端轮询约一分钟并提供取消，不把取消当作供应商免单。周额度与未知用量核对详见 [AI 周额度](ai-quota.md)。

服务端从脱敏简历挑选最多 120 条唯一出现的原文片段，为本次请求分配引用 ID。模型返回 ID 后，服务端回填原文，并校验字段白名单、长度、枚举、片段归属、建议原文不重叠及待补问题中的数字风险。服务端保留原句，使用模型的 `missingInformation` 问题生成 `[请填写真实…]`，不把模型改写直接当作经历。所有 AI 建议设置 `needsConfirmation: true`，必须经过用户审核，结构合法不保证事实语义正确。原报告与规则报告使用相同版本冲突、占位校验和重复应用语义。API 不返回模型密钥、AccessKey 或上游原始报错。

常见模型错误：400 `AI_CONSENT_REQUIRED / MODEL_INPUT_TOO_LONG / USE_ANALYSIS_JOB`，429 `MODEL_BUSY / MODEL_RATE_LIMITED`，502 `MODEL_INVALID_OUTPUT / MODEL_AUTH_FAILED / MODEL_UNAVAILABLE / MODEL_NETWORK_ERROR`，504 `MODEL_TIMEOUT`；取消为 `ANALYSIS_CANCELLED`。无自动降级冒充成功。

## 求职工作台

`CareerJob` 的共享岗位可附招聘类型 `audience`（`campus / internship / experienced / early-career`）与来源核对时间 `checkedAt`。带核对时间且达到 30 天的共享岗位拒绝新建计划，返回 `JOB_RECHECK_REQUIRED`。旧目录及个人岗位可省略这些字段。助手可在 `officialJobs` 返回最多五条近期复核且符合已识别条件的公开岗位摘要，企业历史结果和个人岗位继续使用原字段。 管理员可通过现有 `/admin/career-content/job/{id}` 及 `/draft`、`/preview`、`/apply` 维护共享岗位。草稿须提供官方 HTTPS 详情、类型与已发生的核对日期，发布受修订、预览确认和幂等标识约束。已发布版本供工作台、助手和新投递计划共用。

所有 `/career` 接口要求有效会话，个人数据从会话确定归属。2026-11-07 起按上述工作台会员规则校验：高级可读取完整工作台，免费和初级的 `GET /career` 保留 `mode: preview` 与 `externalDeliveryAvailable: false`，但 `catalogState: empty`，`jobs`、`materials`、`portals`、`favoriteJobIds`、`applications` 均为空；`catalogMessage` 提示升级高级。这里的空数组表示当前权限不下发数据，不证明服务器目录为空，也不删除账号已有资料。权限校验后才提供资料正文、企业详情、筛选计数和招聘链接，不能仅靠前端样式隐藏。

岗位新增与收藏要求高级 `companyJobs`，投递计划新增与修改要求高级 `applications`。本人旧岗位和投递记录的删除接口继续按归属、关联记录及原有修订号条件处理，不增加会员前置条件；本轮没有新增非高级读取旧岗位或计划的界面。本机助手对话仍可清理。工作台不会授予会员或对外代投，契约从 `shared/types.ts` 导出，详细范围见 [求职工作台](career-workspace.md)。

| 方法 | 路径（前缀 `/api/v1`） | 输入 / 返回 |
| --- | --- | --- |
| GET | `/career` | `CareerWorkspace`：高级返回目录状态、岗位、纯文本资料、官方入口、本人收藏和投递记录；免费／初级返回上述空数组 |
| POST | `/career/jobs` | 高级：`CareerJobInput` → 本人添加的 `CareerJob` |
| DELETE | `/career/jobs/:id` | 删除本人添加且无绑定投递记录的岗位；共享目录不可删 |
| PUT | `/career/favorites/:jobId` | 高级：`{favorite:boolean}` → `{jobId,favorite}`，重复设置一致 |
| POST | `/career/applications` | 高级：`{jobId,resumeId,resumeRevision,idempotencyKey}` → `CareerApplication`；快照和哈希由服务端固定 |
| PUT / PATCH | `/career/applications/:id` | 高级：`{revision,status?,note?,resumeId?,resumeRevision?,confirmedManualSubmission?}` → 修改后的 `CareerApplication`；客户端统一使用微信支持的 PUT |
| DELETE | `/career/applications/:id` | `{revision}` → `{deleted:true,id}` |

创建投递计划核对岗位开放状态与截止日期、简历归属和修订号；幂等键相同但输入不同返回冲突。状态允许 `planned → applied / withdrawn`，`applied → interview / offer / rejected / withdrawn`，`interview → offer / rejected / withdrawn`，`offer → withdrawn`；拒绝和撤回为终态。记录 `applied` 必须 `confirmedManualSubmission:true`，且计划快照仍对应当前已保存简历，不含待补事实占位内容。更换绑定仅限计划状态，须先保存与审核，再另行确认已投递。所有状态事件标记 `source:user`、`submissionMode:manual`，不能视为企业反馈或系统发件成功。

旧快照、旧修订号、非法状态转换、无归属资源、关闭/过期岗位等分别返回明确错误。删除原简历级联清理投递快照。个人岗位、收藏、应用及幂等记录为版本 3 单进程 JSON 的新增字段，旧版本迁移补空；没有 MySQL、生产级并发或管理上传接口。

### 公开资料与招聘入口

默认 `.data/career-catalog.json` 不存在时，服务端读取打包的原创公开资料；自定义目录存在时完整替换，损坏时返回 `catalogState: unavailable` 而非静默回退。显式 `careerCatalogPath` 的缺失文件保持空目录。旧目录 `version:1` 继续支持，服务端统一返回 `portals:[]`；`version:2` 必须提供 `jobs`、`materials`、`portals` 数组。

`CareerRecruitmentPortal` 包含 `id`、`organization`、`majors:string[]`、`audience`、`description`、HTTPS `sourceUrl` 和 `checkedAt`。此记录只表示官方入口及本项目核查日期，不能用于创建投递计划，不能自报开放状态；用户核对具体公告并录入个人岗位后再建立计划。资料正文按纯文本阅读，`updatedAt` 为本项目整理/更新时间。`career:build` 与 `career:check` 复用服务端运行时校验，公开资料不包括私有原件或用户履历。详见 [求职资料库](career-library/README.md)。
