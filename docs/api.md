# 项目 API 契约

## 工作台求职助手

`POST /api/v1/career/assistant` 要求有效会话，请求为 `{resumeId?,resumeRevision?,requirements,message,history?}`。选择简历时必须同时提供 ID 和修订号；服务端从本人资料读取正文，检查版本并返回输入 hash 与有限的文本依据，不能由客户端传入另一人的正文或会员身份。对话历史仅用于本次请求，不写入简历或账号数据库。

响应 `engine: local-rules`，包含文字回答、识别的查询条件、未能核验的要求、最多 5 条企业历史资料及最多 5 条本人目标岗位。多轮对话可调整地区等已支持条件；薪资、当前在招等没有数据支撑的要求明确保留为待核对，不给招聘匹配率。空库、损坏目录、过期简历和无匹配分别处理，不静默放宽条件制造结果。修改请求只返回版本绑定的 `analyze-resume` 操作，用户点击后调用原诊断流程，再逐条审核与确认应用；助手接口本身不修改任何简历，不调用真实模型。

## 企业资料查询

`GET /api/v1/career/companies` 与 `GET /api/v1/career/companies/:id` 均要求服务端有效会话。当前返回 `access: authenticated-test`，按用户要求在测试阶段共享企业参考资料；后续会员等级由服务端权益接入，客户端不能自报身份、数据文件路径或会员等级。没有普通用户可调用的企业目录写入接口。

列表参数：`q`（最多 200 字、20 个空格分隔关键词）、`page`（默认 1）、`pageSize`（默认 20，上限 50）、`sort`（`relevance / name / updated`）。多选筛选使用重复参数：`industries`、`natures`、`locations`、`directions`、`educationLevels`、`recruitmentTypes`、`cohorts`，每维最多 30 项。关键词之间 AND，同维度 OR，不同维度 AND；企业全称/别名优先，企业性质关键词的同义词扩展仅作用于企业性质原文，不按名称猜测。未知参数、重复标量、非法分页或外部身份声明返回 400。

返回 `CompanySearchResult` 包含目录状态/版本、分页/总数、`items` 及 `facets`；每个命中项返回经整理的企业资料字段与 `matchedFields`。统计单位是资料记录，不是工商主体数。某一维度的 facet 数量计算时忽略该维度自身选择，保留关键词和其他维度，以支持继续多选；其数量可能大于当前总数。`updated` 指本项目整理时间，不是招聘发布时间。详情返回 `CompanyRecord`，不包含原始文件路径、私人联系人、账号信息或导入审核原件；来源平台名称与链接不进入响应。

缺失文件返回 `catalogState: empty`，损坏文件返回 `unavailable`，不伪装成正常无结果；详情在损坏时为 503 `COMPANY_CATALOG_UNAVAILABLE`，不存在为 404。正常目录无匹配结果仍为 `ready` 且 `total: 0`。目录每次替换后按可信路径与文件签名刷新缓存，所有读取均经过运行时校验。企业资料与实际岗位分开，不能从企业记录直接建立投递计划。字段、数据位置及整理边界见 [企业资料库](company-library.md)。

开发服务默认监听 `http://127.0.0.1:3001`，H5 通过 Vite `/api` 代理访问；服务器由 Nginx 提供同源 HTTPS 反向代理。所有成功响应为 `{ "data": ... }`，错误为 `{ "error": { "code": "...", "message": "..." } }`。共享类型见 `shared/types.ts` 与 `shared/auth.ts`。当前实现邮箱账号、服务端会话和业务资源用户归属检查，仍使用单进程 JSON 存储，尚未迁移 MySQL、接入支付或完成生产能力验收。

## 认证与会话

| 方法 | 路径（前缀 `/api/v1`） | 请求 / 返回 |
| --- | --- | --- |
| GET | `/auth/providers` | `{emailPassword:true,wechat,phone,emailVerification,passwordReset}`；`phone` 与邮件能力字段由实际服务端配置决定，微信绑定能力与微信免登入口分开 |
| POST | `/auth/register` | `{email,password,challengeId?,code?}` → 201 + 会话；邮件启用时必须通过注册验证码，成功后自动登录 |
| POST | `/auth/login` | `{email,password}` → 200 + 会话 |
| GET | `/auth/me` | 返回当前会话的 `{user,expiresAt}`；无有效会话时 401 |
| POST | `/auth/logout` | 撤销当前会话并清除 Cookie，返回 `{signedOut:true}` |
| POST | `/auth/email/code` | `{email,purpose}`，用途为 `register / reset-password / verify-email / bind-email` → 202 + `{challengeId,expiresAt,resendAfterSeconds,message}`；验证本人邮箱与绑定新邮箱需当前会话 |
| POST | `/auth/email/verify` | `{challengeId,code}`，要求有效会话，验证成功返回更新后的 `AuthUser` |
| POST | `/auth/password/reset` | `{email,password,challengeId,code}` → `{passwordReset:true}`；仅支持已验证邮箱账号，不自动登录，并撤销全部旧会话 |
| POST | `/auth/wechat` | 预留微信免登适配位置，当前返回 501 `WECHAT_LOGIN_NOT_CONFIGURED` |
| POST | `/auth/phone/code` | `{phone,purpose}` → 202 + 挑战；用途为 `login / bind-phone / verify-account`，后两者需会话 |
| POST | `/auth/phone` | `{phone,challengeId,code}` → 200 + 会话；号码未绑定则在验证码验证后创建独立手机号账号 |
| POST | `/auth/phone/bind` | `{phone,challengeId,code,currentPassword?}` 或当前手机证明 `currentCode/currentChallengeId`；需会话，返回本人 `AuthUser` |
| POST | `/auth/email/bind` | `{email,challengeId,code,currentPassword?}` 或当前手机证明；无密码账号另需新 `password`；需会话 |

`user` 只包含公开账号字段 `{id,email?,phone?,emailVerified,phoneVerified?,hasPassword?,createdAt}`，不包含密码哈希或会话哈希。邮箱会去除两端空白并转小写，最多 254 字符；新密码为 6–16 位，只能使用字母、数字和符号，不能包含空格、中文或控制字符。登录仍接受 6–128 位不含控制字符的旧密码，密码不自动去除空白。请求须经过服务端字段白名单、类型及长度校验，不能仅凭客户端类型信任输入；注册与登录有频率和密码计算并发限制。

H5 使用名为 `youfang_session` 的 HttpOnly、SameSite=Lax Cookie，生产环境启用 Secure；H5 注册和登录响应不返回原始令牌。小程序在注册或登录请求中声明 `X-Auth-Client: mp-weixin`，服务端才在会话响应中附加 `token`；后续发送 `Authorization: Bearer <token>`。此请求头只选择会话传输方式，不授予微信身份、会员或额外权限。会话绝对有效期为 7 天，退出后撤销，重启服务后仍以持久化会话状态验证。服务端只保存随机令牌的 SHA-256 哈希。

`/health`、`/plans` 与认证入口允许未登录访问；`/membership`、`/membership/quota`、账单预览以及所有简历、报告、诊断任务和建议应用接口要求有效会话。所有资源查询与修改均从可信会话确定用户，不能通过客户端提交 `userId` 越权；请求其他用户资源按不存在返回 404。不同用户的草稿与工作空间缓存也分别保存。

H5 通过同源接口访问，Cookie 写请求需要来源校验。部署通过 `AUTH_TRUSTED_ORIGINS` 配置精确来源列表，不把客户端传入的 Host 或转发头视为授权；小程序 Bearer 通道不依赖浏览器 Cookie。`AUTH_SECURE_COOKIES` 控制 Cookie 的 Secure 属性，默认随 `NODE_ENV=production` 启用，公网 HTTPS 不应关闭。

`emailVerified` 仅在完成邮箱证明后为 `true`。旧账号保留原状态，缺省为 `false`，必须先凭原密码登录后完成本人邮箱验证，才能使用找回密码；找回流程不用于认领或提升未验证的旧账号。客户端提交 `emailVerified` 不能授予验证状态。微信免登和微信授权手机号仍未接入。短信验证码登录、注册和绑定已接入代码，是否可用由 `phone` 能力字段与真实配置决定，关闭时返回 `SMS_NOT_CONFIGURED`，不返回假验证码或登录成功。

## 手机号验证码与绑定

当前短信提供方为腾讯云，默认关闭；尚无已确认的短信应用 SDKAppID、审核通过签名名和模板 ID。本轮代码发布不写入真实短信配置、不使用聊天密钥、不发真实短信。`phone:true` 仅表示服务端已启用并通过配置校验，不等于供应商权限、余额或最终收件已验证。配置、请求及费用边界见 [手机号与短信](phone-auth.md)。

手机号登录只接受号码、随机挑战 ID 和六位验证码，不信任客户端传入的 `userId`、验证状态或会员身份。已绑定号码登录原账号；未绑定号码验证后原子创建 phone-only 账号，不生成假邮箱或默认密码。新绑定只增加当前账号登录标识，保持原账号 ID、简历、会员与会话范围；目标标识属于其他账号时拒绝，不自动合并。

绑定要求有效会话、目标 `bind-phone / bind-email` 验证码和当前身份证明：已有密码使用 `currentPassword`，phone-only 使用当前已绑定手机号的 `verify-account` 验证码 `currentCode/currentChallengeId`；无密码账号绑定邮箱还须设置合规新密码。用途、目标、挑战 ID 与用户均须匹配，登录码不能作绑定码。现有邮箱不直接替换，当前没有改绑或解绑接口。

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
| GET | `/plans` | 返回 `free / basic / premium` 三档权益与服务器价格（分）；未配置支付时 `paymentAvailable` 为 false，价格仍返回当前服务端配置 |
| GET | `/billing/quote?planId=` | 返回 `MembershipQuote`：金额、`purchase/renewal/upgrade`、当前方案；升级补差价由服务端计算 |
| POST | `/billing/checkout` | `{planId,requestId,channel?}`，`channel` 为 `jsapi`（默认，小程序）或 `native`（H5 扫码）→ 201 创建或复用 `pending` 订单；JSAPI 返回订单摘要 + `wx.requestPayment` 参数，Native 返回订单摘要 + `native.codeUrl/qrCodeDataUrl/expiresAt`；未配置支付返回 503 `PAYMENT_NOT_CONFIGURED`；JSAPI 未绑定微信返回 409 `WECHAT_NOT_BOUND`；同一 `requestId` 换方案/金额/支付方式返回 409 `IDEMPOTENCY_KEY_CONFLICT` |
| GET | `/billing/orders/:id` | 返回当前会话本人的订单摘要（不含 prepayId 或其他用户订单）；不存在按 404 |
| POST | `/billing/wechat/notify` | 微信支付 v3 异步通知入口，公开但必须通过平台公钥验签；处理成功返回 `{code:'SUCCESS'}`，失败返回错误且不发放会员 |
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

请求体上限 256 KB；简历正文 50,000 字符；JD 15,000 字符；简历名称及目标岗位各 120 字符；单条修改文本 20,000 字符。字符串统一换行并移除首尾空白，不接受空正文、空名称、未知字段及错误类型。写入使用 `application/json`；文件解析由前端完成，API 不接收文件二进制。导出接口只接收版本、格式和版式，正文由服务端从已保存简历读取，文件以 JSON 中的 `contentBase64` 返回。

| HTTP | 常见 code | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | 字段或 JSON 无效 |
| 400 | `CONFIRMATION_REQUIRED` / `PLACEHOLDERS_UNRESOLVED` | 建议尚未核实或占位未填 |
| 401 | `AUTH_REQUIRED` / `INVALID_CREDENTIALS` | 会话缺失或过期、邮箱密码不匹配 |
| 403 | `ORIGIN_NOT_ALLOWED` | Cookie 写请求来源未获授权 |
| 403 | `MEMBERSHIP_EXPIRED` | 会员已到期，拒绝新的真实模型调用 |
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
| 501 | `WECHAT_LOGIN_NOT_CONFIGURED` | 微信免登适配器尚未接入 |
| 502 | `EXPORT_RENDER_FAILED` | 文件渲染失败或生成结果无效 |
| 503 | `MAIL_NOT_CONFIGURED` / `MAIL_DELIVERY_FAILED` | 邮件服务未配置或发送未成功，不能视为验证码已发送 |
| 503 | `SMS_NOT_CONFIGURED` / `SMS_DELIVERY_FAILED` | 短信未启用或提交未获确认，不能视为已送达或验证码可用 |
| 429 | `SMS_RATE_LIMITED` / `SMS_BUSY` / `CODE_RESEND_TOO_SOON` | 短信发送限额、在途并发或冷却限制 |
| 504 | `EXPORT_TIMEOUT` | 导出超过 20 秒未完成 |

账号、会话、简历、报告、邮件和短信挑战、诊断任务、可信会员事件与模型用量账本落盘到 `.data/resumes.json` 的版本 3 格式，采用临时文件 + rename 原子提交，写入权限为当前用户可读写；密码使用 scrypt 哈希，不保存明文密码。兼容迁移保留版本 1 的旧无主简历与报告隔离，不自动分配给第一位注册账号；版本 2 的账号、会话及业务归属继续保留，旧邮箱验证状态不会被擅自提升。此存储仅支持单进程，不是生产数据库；文件解析文本和账号邮箱可能包含个人信息，请按真实业务需要配置保留与删除策略，备份不得提交 Git。

## 权益与充值预览

权益页使用 `free / basic / premium` 三档：免费体验包含模板简历；初级会员规划提供简历优化；高级会员包含初级权益，以及按专业分类的公司和岗位信息、复习资料、精选投递（智能投递）。工作台提供岗位目录筛选、个人岗位添加、收藏、复习正文阅读和投递计划/手动进度记录；默认包含覆盖现有 16 个专业的应届生准备材料和官方招聘入口；入口不等同在招岗位，当前没有自动执行投递。会员权益、价格和周期由服务端返回，客户端不能自行授予身份。已确定金额使用整数分；付费 `priceCents: null` 表示待定价，不能按零元商品处理。AI 周额度已采用实际输入加输出 Token 结算，后台试运行上限为初级 200,000、高级 800,000 Token；公共响应只提供剩余百分比，不使用固定次数或点数。详情见 [AI 周额度](ai-quota.md)。

`membership.policy` 描述一个自然月、手动续费、上海时区及初级升高级的补差价和周期重置规则。有效初级升级时应补高级月价减初级月价；服务端确认支付成功后立即生效，在原到期日基础上顺延一个自然月，原剩余天数保留。月末无对应日期时取次月月底同一时刻；已过期按高级新购。同档有效会员续费从原到期时刻延长一个自然月，过期后从确认付款时刻起算。详见 [会员机制](membership.md)。这些是本项目产品规则，不是对其他平台退款、抵扣政策的承诺。

`AiQuotaSummary.status` 为 `preview / active / inactive`。仅 `active` 带 0–100 的整数 `remainingPercent` 与 ISO 时区时间；百分比按已确认实际用量计算并向上取整，正余额不会被舍入为 0%。`pending` 表示尚有处理或用量核对，预占不作为实际扣减展示；百分比大于零不保证可以绕过在途任务或保守预占检查。周起点来自首次可信激活，每 7 天刷新；`resetsAt` 到会员末期截断为 `expiresAt`，此时界面显示额度有效至而非承诺续期刷新。续费和升级保持周起点，升级保留本周消耗后换用高级总量。

充值接口只接受 `{planId}`。旧 `single / weekly / monthly` 档位、无效方案及免费方案返回 400，也拒绝客户端提交价格、会员等级、有效期或支付结果等字段。合法 `basic / premium` 方案返回 `{error:{code:'PAYMENT_NOT_CONFIGURED',message:'会员价格待定，支付暂未开放，本次未扣费。'}}`（503）。默认没有可信会员记录时仍为免费预览，额度状态 `preview`、百分比和刷新/到期值为 `null`，不虚构余额或有效期；有有效服务端记录时返回 `mode: active`、对应等级、`limitsEnforced: true` 和有效周额度摘要；记录已过期时为 `quota.status: inactive`，百分比及刷新时间为 `null`，保留实际到期时间。`paymentAvailable` 始终为 `false`。已有单进程持久化会员事件和额度账本，但没有支付 SDK、支付回调或真实订单发放链路；内部 `activateMembership` 仅供未来已验证支付适配器和受信测试，不是用户可调用的 HTTP 授予接口。规则日期计算和查看方案均不改变账号权益，页面不提供可点击的开通操作。

## 百炼诊断

`engine: bailian` 表示真实模型建议通过结构及来源校验；`modelRun` 固定模型名、提示词版本、工作流版本、温度、输出上限、脱敏输入 hash、告知版本与确认记录，`knowledgeScope: none` 明确尚未检索知识库。参考分、维度和关键词仍来自规则基线，前端分别标注，不将文本覆盖包装为实际能力。

任务受限为单进程全局单并发，任务 ID、输入快照、修订号、输入/请求 hash、模型与工作流配置和幂等键持久化到 `analysisTasks`；不是多实例生产任务队列。同一用户、同一幂等键和相同输入返回原任务，不再次调用模型；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。进程启动将旧 `queued / running` 任务标为 `failed`、错误码 `JOB_INTERRUPTED`，保留 ID，不自动重放。尚未发送的额度预占释放；已发送但没有实际用量的记录转为 `pending`。

输入绑定提交时简历修订号，生成期间或保存前修改会拒绝写报告；取消在报告持久化提交前生效。模型响应中的实际输入/输出 Token 在内容校验前结算，因此失败、超时、取消、版本冲突或保存失败不撤销已发生的用量；尚未派发的失败不扣减。已派发而没有有效供应商 `usage` 时保留待核对，阻止该用户新模型请求；不能按字数或失败状态估算扣减。完成报告也不保证用量已结算，缺失 `usage` 的成功报告仍可能伴随 `pending`。GET 报告、确认应用、导出及本地规则不消耗模型额度。

服务端模型超时 45 秒、自动重试次数 0、输出最多 4,000 tokens、响应最多 96 KB、脱敏输入 JSON 最多 20,000 字符。客户端轮询约一分钟并提供取消，不把取消当作供应商免单。周额度与未知用量核对详见 [AI 周额度](ai-quota.md)。

字段白名单、长度、枚举、原文唯一定位、建议原文不重叠及待补问题中的数字风险均由服务端校验。服务端保留原句，使用模型的 `missingInformation` 问题生成 `[请填写真实…]`，不把模型改写直接当作经历。所有 AI 建议设置 `needsConfirmation: true`，必须经过用户审核，结构合法不保证事实语义正确。原报告与规则报告使用相同版本冲突、占位校验和重复应用语义。API 不返回模型密钥、AccessKey 或上游原始报错。

常见模型错误：400 `AI_CONSENT_REQUIRED / MODEL_INPUT_TOO_LONG / USE_ANALYSIS_JOB`，429 `MODEL_BUSY / MODEL_RATE_LIMITED`，502 `MODEL_INVALID_OUTPUT / MODEL_AUTH_FAILED / MODEL_UNAVAILABLE / MODEL_NETWORK_ERROR`，504 `MODEL_TIMEOUT`；取消为 `ANALYSIS_CANCELLED`。无自动降级冒充成功。

## 求职工作台

所有 `/career` 接口要求有效会话，个人数据从会话确定归属。当前为高级会员功能预览，不授予付费身份，不接支付或外部代投。契约从 `shared/types.ts` 导出，详细范围见 [求职工作台](career-workspace.md)。

| 方法 | 路径（前缀 `/api/v1`） | 输入 / 返回 |
| --- | --- | --- |
| GET | `/career` | `CareerWorkspace`：目录状态、岗位、纯文本资料、官方招聘入口 `portals`、本人收藏与投递记录 |
| POST | `/career/jobs` | `CareerJobInput` → 本人添加的 `CareerJob` |
| DELETE | `/career/jobs/:id` | 删除本人添加且无绑定投递记录的岗位；共享目录不可删 |
| PUT | `/career/favorites/:jobId` | `{favorite:boolean}` → `{jobId,favorite}`，重复设置一致 |
| POST | `/career/applications` | `{jobId,resumeId,resumeRevision,idempotencyKey}` → `CareerApplication`；快照和哈希由服务端固定 |
| PUT / PATCH | `/career/applications/:id` | `{revision,status?,note?,resumeId?,resumeRevision?,confirmedManualSubmission?}` → 修改后的 `CareerApplication`；客户端统一使用微信支持的 PUT |
| DELETE | `/career/applications/:id` | `{revision}` → `{deleted:true,id}` |

创建投递计划核对岗位开放状态与截止日期、简历归属和修订号；幂等键相同但输入不同返回冲突。状态允许 `planned → applied / withdrawn`，`applied → interview / offer / rejected / withdrawn`，`interview → offer / rejected / withdrawn`，`offer → withdrawn`；拒绝和撤回为终态。记录 `applied` 必须 `confirmedManualSubmission:true`，且计划快照仍对应当前已保存简历，不含待补事实占位内容。更换绑定仅限计划状态，须先保存与审核，再另行确认已投递。所有状态事件标记 `source:user`、`submissionMode:manual`，不能视为企业反馈或系统发件成功。

旧快照、旧修订号、非法状态转换、无归属资源、关闭/过期岗位等分别返回明确错误。删除原简历级联清理投递快照。个人岗位、收藏、应用及幂等记录为版本 3 单进程 JSON 的新增字段，旧版本迁移补空；没有 MySQL、生产级并发或管理上传接口。

### 公开资料与招聘入口

默认 `.data/career-catalog.json` 不存在时，服务端读取打包的原创公开资料；自定义目录存在时完整替换，损坏时返回 `catalogState: unavailable` 而非静默回退。显式 `careerCatalogPath` 的缺失文件保持空目录。旧目录 `version:1` 继续支持，服务端统一返回 `portals:[]`；`version:2` 必须提供 `jobs`、`materials`、`portals` 数组。

`CareerRecruitmentPortal` 包含 `id`、`organization`、`majors:string[]`、`audience`、`description`、HTTPS `sourceUrl` 和 `checkedAt`。此记录只表示官方入口及本项目核查日期，不能用于创建投递计划，不能自报开放状态；用户核对具体公告并录入个人岗位后再建立计划。资料正文按纯文本阅读，`updatedAt` 为本项目整理/更新时间。`career:build` 与 `career:check` 复用服务端运行时校验，公开资料不包括私有原件或用户履历。详见 [求职资料库](career-library/README.md)。
