# 服务器部署

当前部署通过项目内的邮箱注册、登录页面进入各自工作空间；Nginx 不再使用共享 Basic Auth，因此不再弹出浏览器用户名/密码窗口。应用配置允许匿名加载页面、健康检查和公开占位模板；简历、报告、任务、建议应用、求职工作台和权益预览等业务接口由服务端会话鉴权，并检查用户归属。实际公网可达性还受备案及网络状态影响，见下方排查记录。

2026-10-25 按用户授权更新高级会员求职工作台：个人岗位、收藏、简历版本绑定的投递计划与手动进度记录已接入服务器。共享岗位与复习内容等待后续提供，管理后台本轮不做。工作台仍为登录用户可体验的会员功能预览，不收费、不授予付费身份、不自动代投；操作说明见 [求职工作台](career-workspace.md)。

2026-11-07 的工作台权限更新替代上述历史预览安排：简历优化入口要求有效初级或高级会员，求职助手、公司岗位、招聘入口、复习资料和投递计划要求有效高级会员。界面锁态来自服务端 `/api/v1/membership/workbench`，受限查询与写入另由服务端校验；非高级的 `/career` 不下发工作台内容，权限不足返回 403。首页免费规则检查、简历编辑、历史报告与导出保留。该更新不更改服务器模型、支付、短信或其他业务配置，不代表已完成真实支付、页面或微信真机验收；部署仍分别核对源站与公网可达性。

服务仍是单进程 Node + JSON 文件存储，不是 MySQL 或多实例生产系统。微信小程序静默免登已接入，需在服务端配置小程序 AppID/AppSecret；未配置时返回 501 并回退邮箱登录。邮箱验证码用于注册、已有账号邮箱验证和找回密码，是否开放由服务端邮件配置决定。旧未验证账号须先凭原密码登录并完成本人邮箱验证，之后才能使用找回密码；手机号验证码登录/注册及同账号绑定已接入代码，短信默认关闭，不要把代码或页面入口当作已配置可发送。新密码须为 6 至 16 位且只能使用字母、数字和符号（不含空格和中文），注册与找回密码均按此校验；登录兼容 6–128 位旧密码。

## 代码与服务器同步约定

2026-10-27 用户明确要求将当前版本部署到既有服务器、上传 [huangfeiyang05/resume](https://github.com/huangfeiyang05/resume)，并要求后续代码更新同步 Git 和服务器。这是本项目既有发布范围的持续授权，取代上一开发批次“不部署”的限制；无需为同一范围重复询问。用户当轮明确只本地修改、只审查、不推送或不部署时，以当轮要求为准。本节记录授权与流程，不代表任何一次推送或部署已经成功。

每次有代码或随包资料变更时：

1. 检查工作区、仓库实际工作分支和远端变化，核对待提交范围。源码、原创公开资料、依赖清单和必要配置示例可提交；`.data/`、用户简历、原始附件、截图中的个人信息、备份、密钥和本机运行配置不能提交。不强推或覆盖无关远端改动。
2. 执行与变更相关的类型检查、行为测试和构建；发布包继续使用下方白名单，只包含 H5、编译后 API、运行依赖、公开原创资料、部署配置与许可证。记录对应 Git 提交和发布目录，以便核对服务器版本。
3. 提交并推送到 `huangfeiyang05/resume`，检查远端提交确已更新；使用同一版本的构建产物部署既有 `resume-youfang` 服务。任一环节失败时明确记录已完成和未完成部分，不能把只推送或只部署称为全部同步完成。
4. 沿用新的 `/opt/resume-youfang/releases/<版本>/` 目录，发布前保留权限受限的数据备份和可恢复的上一版，再切换 `current` 并按现有服务方式重启。不要覆盖 `/var/lib/resume-youfang/`、`/etc/resume-youfang/runtime.env` 或密钥；不要借代码同步开启真实模型、真实支付或修改业务配置及其他生产资源。
5. 分别校验源站 HTTPS、健康检查、业务鉴权、公开模板与本次功能所需的命令行 API 行为，再独立检查公网可达性。备案未完成或接入层阻断时如实报告；不绕过阻断，不将服务器内部正常表述为公网已恢复。继续按用户要求不执行浏览器、截图或显示效果检查，页面效果与微信真机另行验收。

该约定是每次维护工作的发布步骤，没有创建定时任务、常驻同步进程或携带服务器密钥的 GitHub Actions。新增平台能力和资质接入仍按真实条件另行实施。

## 公网故障与备案前置条件

2026-10-26（北京时间）用户反馈网站尚未完成 ICP 备案，访问 `https://www.youfangcv.site` 出现 `ERR_CONNECTION_CLOSED`。本次仅执行只读网络和服务器检查，未修改生产配置、重启服务或重新部署。

| 检查项 | 本次结果 |
| --- | --- |
| 公共 DNS | `youfangcv.site`、`www.youfangcv.site` 的 A 记录均为 `110.40.158.26`；`www` 无 AAAA 记录 |
| 服务器地域 | 腾讯云上海 `ap-shanghai` |
| 运行状态 | Nginx、`resume-youfang` 均为 active，`nginx -t` 通过，80/443 正在监听 |
| HTTPS 证书 | 覆盖根域名和 `www`，有效至 2027-01-23 |
| 服务器内部访问 | 两个域名经回环地址进行 HTTPS 证书校验，`/api/v1/health` 均返回 200 |
| 公网访问 | HTTP 返回 301 跳转 HTTPS；HTTPS 携带上述域名的 SNI 时握手被关闭；同一公网 IP 不带 SNI 时可完成 TLS 握手 |

这些当次结果高度符合域名在公网接入层被拦截的现象，结合用户提供的未备案状态，优先按腾讯云未备案阻断处理；具体拦截原因仍以腾讯云控制台记录或客服核实为准。截至该次排查公网访问未恢复，后续状态以每次独立检查为准。服务正常、证书有效及历史连通性验收均不能替代备案或当前公网验收。

腾讯云明确要求使用中国大陆服务器的网站先完成 ICP 备案；首次备案仍在审核时不能解除拦截。来源：[网站/APP 阻断相关](https://cloud.tencent.com/document/faq/243/20220)（本次核对日期 2026-10-26）。

处理步骤：

1. 使用服务器所属腾讯云账号进入 [ICP 备案控制台](https://console.cloud.tencent.com/beian)，填写网站域名 `youfangcv.site`，由系统核验首次备案或其他备案场景；选择与 `110.40.158.26` 对应且具备备案资格的云资源。
2. 按真实主办者选择个人或单位主体，完成域名实名认证、主体与负责人资料、网站信息及平台要求的核验。主体、省份和材料按真实情况填写；证件资料直接提交到官方控制台，不保存在项目内。完整流程见 [腾讯云首次备案指引](https://cloud.tencent.com/document/product/243/97668)。
3. 网站能力按实际实现申报：邮箱账号、简历编辑与保存、透明规则诊断、文本关键词检查、对照确认和文件导出；服务器当前关闭真实模型，RAG、支付及自动投递尚未开放。网站名称、服务内容与主体资质须符合实际情况及当地管局要求，不能把规划功能写成已上线事实。
4. 完成备案并待接入商同步后，再检查两个域名的 HTTPS 首页、健康检查、未登录业务接口 401 和公开模板下载。取得真实备案号后，按备案后要求展示备案信息；当前未取得备案号，不填写占位号或声称已备案。

负责人实名、人脸和短信核验需要由本人在官方流程中完成。本次未提交备案申请。

后续排查可在服务器执行以下只读检查，验证源站 HTTPS 与应用健康状态；这不代表公网已恢复：

```sh
systemctl is-active nginx resume-youfang
sudo nginx -t
sudo openssl x509 -in /etc/letsencrypt/live/youfangcv.site/fullchain.pem -noout -dates -ext subjectAltName
curl --fail --silent --show-error --noproxy '*' --connect-timeout 5 --max-time 10 --resolve www.youfangcv.site:443:127.0.0.1 https://www.youfangcv.site/api/v1/health
```

## 构建与上传

本机的 SSH 连接配置与已核对的主机公钥保存在被忽略的 `.deployment/ssh-config` 和 `.deployment/known_hosts`；私钥仍保存在原受限位置，不进入项目或发布包。可用 `ssh -F .deployment/ssh-config resume-youfang` 连接既有服务器。Git 的远端为 `git@github.com:huangfeiyang05/resume.git`，本机仓库使用 SSH 443 通道，以兼容当前网络；不修改全局 SSH 设置。

```sh
npm ci
npm test
VITE_TEMPLATE_BASE_URL=https://www.youfangcv.site npm run build:release
# macOS: do not transfer Finder metadata or extended attributes.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf dist/resume-youfang.tar.gz -C dist/release .
```

`build:release` 包含类型检查、H5、微信、管理网页及独立 Node 后端构建。发布包将管理网页放在 `www/admin/`，由现有 Nginx 同源提供。管理员授权独立于发布流程，见 [管理后台说明](admin.md)。发布包内容为网页、编译后 API、运行时依赖、部署配置和许可证。`dist/build/mp-weixin` 保留在本机供开发者工具导入。

打包后自动运行 `npm run release:verify`：直接加载发布包中的编译模块，在临时数据库和回环地址验证账号隔离、强制修订号、历史恢复/幂等、删除及资料包读取；不使用线上账号、不发送邮件或调用模型。上传后的服务器也可运行 `/opt/nodejs/bin/node <新版本目录>/ops/verify-release.mjs <新版本目录>` 验证目标环境，临时数据在结束时清理。它不替代真实数据的只读兼容检查、生产服务校验或页面/真机验收。

发布包根目录 `release.json` 记录 `gitCommit` 与 `gitDirty`。常规部署使用已提交、干净的版本；先核对包内提交号，再上传到新的发布目录。目标版本准备完成后，可用 `sudo bash <新版本目录>/ops/activate-release.sh <发布ID> <预期旧版本路径> <完整Git提交号>` 激活。脚本使用锁和预期版本检查，读取验证旧数据兼容性，停服务后备份业务数据，原子切换代码并校验健康与未登录权限；失败恢复旧程序，不把旧备份覆盖到可能已有新写入的数据上。运行前仍需检查包清单、摘要及目标服务器，脚本不修改运行时配置或备案状态。

运行环境要求 Node.js 22.13.0 以上；本服务器使用官方 Node.js 24 发行包。安装时校验对应官方 SHA-256，不在服务器运行 Vite 或 TypeScript 开发进程。

## 目录与进程

| 位置 | 用途 |
| --- | --- |
| `/opt/resume-youfang/releases/<版本>/` | 每次上传的独立构建产物 |
| `/opt/resume-youfang/current` | 当前版本的符号链接 |
| `/opt/nodejs` | Node.js 官方运行时 |
| `/var/lib/resume-youfang/.data/resumes.json` | 独立于程序发布的业务数据，包括账号、简历、诊断、求职、后台发布及审计记录。首次保存退款申请时升为版本 4 |
| `/var/lib/resume-youfang/.data/career-catalog.json` | 可选自定义底稿。存在时替换打包底稿，缺失时使用随服务发布的原创公开资料，后台按条目发布时不改写此文件 |
| `/var/lib/resume-youfang/.data/career-files/` | 私有复习资料附件，按格式和内容摘要去重，代码发布时随账号数据备份。保留原件以支持回滚 |
| `/var/lib/resume-youfang/.data/company-catalog.json` | 经审核的企业招聘参考资料，经有效会话与高级会员权限校验后提供查询；仅单独授权的数据导入写入，不随代码包或 Git 上传，代码发布时只读校验并受限备份 |
| `/var/lib/resume-youfang/.data/company-batches/` | 后台企业资料批次历史和版本快照。代码发布时随企业目录一并受限备份 |
| `/etc/resume-youfang/runtime.env` | 可选服务器配置，不提交 Git，不放静态目录 |
| `/etc/nginx/sites-available/resume-youfang` | 生效的站点配置 |
| `/etc/systemd/system/resume-youfang.service` | 单实例 API 服务 |
| `/etc/letsencrypt/` | HTTPS 证书、私钥与续期配置 |
| 本机 `.deployment/` | 本机部署记录和受限配置，目录忽略且权限受限 |

API 以独立系统账户 `resume-youfang` 运行，仅监听 `127.0.0.1:3001`。Nginx 提供 H5 和同源 `/api/` 反向代理；80 端口用于证书验证及重定向，443 端口提供 HTTPS。云服务器防火墙需允许公网 TCP 80、443，API 端口无需开放。

复习附件通过管理员接口分片上传，沿用现有 256 KB 请求限制。小程序打开文档或视频使用 API 的同一 HTTPS 域名，需在微信后台配置为 downloadFile 合法域名。网页视频经同源接口分段读取，每段独立校验会话、会员和发布版本。文件和历史版本保留在服务端，当前容量上限为 512 MiB 和 2,000 个文件，发布前保留受限附件备份。视频元数据单独保存于账号库的 `careerVideos` 字段，回退到仅支持文档的版本时，视频条目可退回纯文本呈现。

H5 API 构建应保留 `VITE_API_BASE_URL` 为空，使用当前站点的同源地址，避免根域名页面跨域调用 `www` 域名。微信包需要单独指定公开 API 地址再构建：

```sh
VITE_API_BASE_URL=https://www.youfangcv.site VITE_TEMPLATE_BASE_URL=https://www.youfangcv.site npm run build:mp-weixin
```

如果部署到其他域名或子路径，必须同步调整域名、精确来源白名单和客户端公开地址，不能仅修改客户端跳过来源检查。Nginx 需将 Bearer `Authorization` 头传给后端，不能保留旧 Basic Auth 配置中清空该头的行为。

服务器 `/etc/resume-youfang/runtime.env` 至少配置实际使用的 H5 来源与安全 Cookie：

```ini
AUTH_TRUSTED_ORIGINS=https://www.youfangcv.site,https://youfangcv.site
AUTH_SECURE_COOKIES=true
```

配置权限保持 `0600`，修改后重启 `resume-youfang`。H5 的 `youfang_session` 为 HttpOnly、SameSite=Lax、Secure Cookie；小程序邮箱登录通过 `X-Auth-Client: mp-weixin` 获取 Bearer 令牌。会话绝对有效 7 天，退出会撤销服务端会话。不要在公网关闭 Secure，不要把会话令牌放进 URL 或 Nginx 访问日志。

## SMTP 与验证码配置

在服务器 `/etc/resume-youfang/runtime.env` 中配置邮件参数，文件权限设为 `0600`；本机可用已忽略的 `.deployment/mail-163.env` 保存私密配置。应用读取服务端环境变量，不能把邮件凭据加上 `VITE_` 前缀或复制到静态目录。当前 163 发信使用以下结构，示例中的邮箱和密钥均须替换为真实配置，不能提交 Git：

```ini
MAIL_ENABLED=true
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.163.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-mailbox@163.com
SMTP_PASSWORD=<客户端授权码>
MAIL_FROM="简历有方 <your-mailbox@163.com>"
MAIL_CODE_SECRET=<独立生成的至少32随机字节密钥>
```

`MAIL_CODE_SECRET` 用于绑定验证码、邮箱、用途与挑战 ID 的 HMAC，不可复用 SMTP 授权码。更换后未消费验证码需要重新获取；不要将密钥或原始验证码写入命令行参数、API 响应、日志、截图或 Git。更换配置后重启服务。生产服务要求验证码注册，邮件关闭或未配置时必须拒绝注册，不可静默降级为只填邮箱密码。

验证码为 6 位随机数字，有效期 10 分钟，至少 60 秒后重发，最多 5 次错误；挑战、冷却和发送限额持久化到版本 3 数据。SMTP 发送成功后才可使用验证码；失败返回安全错误，不假报发送成功。找回仅支持已验证邮箱的账号，在一次持久化中修改密码、撤销该账号全部旧会话及其他关联挑战，不自动登录，原有简历和报告仍属于原账号。未验证旧账号不得通过找回流程被认领或重置。

测试使用注入的假发信器验证注册、过期、错误次数、重发、并发单次消费及重置撤销，不发送真实测试邮件。真实配置只进行 SMTP 连接、TLS 与认证握手检查；这不证明最终邮件送达或进入收件箱，用户需自行进行实际收件验收。前端显示效果和微信真机也由用户另行验收。

首次证书申请前使用 `deploy/nginx-bootstrap.conf`，仅提供 ACME 验证文件；拿到证书后切换至 `deploy/nginx.conf`。证书覆盖 `www.youfangcv.site` 和 `youfangcv.site`，通过 Certbot webroot 验证，续期成功后执行 `deploy/renew-nginx.sh` 校验并重载 Nginx。启用系统 `certbot.timer` 并进行续期演练。

默认 `BAILIAN_ENABLED=false`，本机模型密钥不会上传。后续需要启用真实模型时，在服务器单独设置 `/etc/resume-youfang/runtime.env`，权限设为 `0600`，只加入项目已有的 `BAILIAN_ENABLED`、`DASHSCOPE_API_KEY` 等服务端变量，然后重启服务。不得上传本机 YAML 中无关的阿里云 AccessKey。

## 维护与验证

```sh
sudo systemctl status resume-youfang nginx
sudo journalctl -u resume-youfang -n 50 --no-pager
sudo nginx -t
sudo certbot certificates
sudo systemctl list-timers certbot.timer
sudo certbot renew --dry-run
```

验收只执行类型检查、行为测试、构建及必要的命令行 API 检查；按用户要求，不打开浏览器、不截图、不验证显示效果，实际页面由用户自行验收。未登录访问页面和 `/api/v1/health` 应成功，未登录访问 `/api/v1/resumes` 应返回 401；注册登录后只能读取和修改本人业务资源，跨账号请求应失败；HTTP 应跳转 HTTPS，未经授权的外部来源 Cookie 写入应被拒绝。验证保存、分析、事实确认和版本冲突时只创建专用测试记录，结束后清理。不要将真实简历、邮箱密码或会话令牌写入命令行、日志或 Git。

更新时上传到新的版本目录，检查产物后切换 `current` 并重启 API；不要覆盖 `/var/lib/resume-youfang/`。验证码接入将存储格式升级为版本 3；升级前保留服务器上权限受限的数据备份。版本 1 的旧无主简历与报告继续隔离，对新注册用户不可见，禁止自动分配给第一位注册账号；版本 2 的账号、会话及用户归属保留，未验证邮箱不会被自动提升状态。

回退必须选择兼容当前数据格式、保留服务端鉴权的版本，数据文件不随程序回退；验证码密钥与当前数据必须匹配，不得通过回退跳过注册验证。回退到内容管理上线前的程序会重新展示底稿，后台操作历史仍保存在数据文件中，重新切回兼容版本后恢复对应条目。历史无鉴权版本不能直接与已移除 Basic Auth 的 Nginx 配置组合运行；确需回退时，先恢复受控入口并核对数据格式，避免把已有资料裸露到公网。历史 `/etc/resume-youfang/htpasswd` 和本机旧共享访问凭据不再参与新版邮箱登录。

版本 4 含退款账本。产生退款申请后，恢复服务需使用支持退款的 API 版本并继续读取当前账本，保留渠道已受理的退款及其他业务写入。

发布后台价格需要账本版本 5。首次保存带报价确认标识的订单或预约续费记录会升级为版本 6。恢复服务使用兼容当前账本版本的 API，保留上线后新增的订单和退款记录。测试库带有独立环境标识，公开服务拒绝读取。运行测试版使用 [本机测试环境](admin.md#测试版与公开版)。

微信端可按同一邮箱登录契约接入 HTTPS API；这不是微信身份免登，仍需后续配置小程序服务端凭据、服务端 code 交换和账号关联。手机号验证码登录/注册及绑定代码已接入，但短信默认关闭，不接受客户端自报手机号作为可信身份；需要已启用服务端短信配置及有效挑战证明，详见 [手机号与短信](phone-auth.md)。公开占位模板继续使用该 HTTPS 域名；小程序后台需配置请求及下载域名，并由用户另行做真机验证。构建通过不代表真机验证通过。

## 腾讯云短信配置与手机号账号

本轮接入手机号验证码登录/注册及同账号手机号、邮箱绑定，未启用真实短信。实际供应商为腾讯云；资质“已通过”且关联签名为 0 的截图不能证明已可发送。当前尚缺用户确认的 SDKAppID、审核通过的签名名和模板 ID，不能补造占位值或用聊天中发送的密钥启用。该次代码发布只交付能力和默认关闭示例，不修改 `/etc/resume-youfang/runtime.env`、不发真实短信。

待真实材料和独立配置授权齐备后，由维护者在权限为 `0600` 的服务器环境文件设置：

```ini
SMS_ENABLED=false
SMS_PROVIDER=tencent
TENCENT_SMS_SECRET_ID=
TENCENT_SMS_SECRET_KEY=
TENCENT_SMS_SDK_APP_ID=
TENCENT_SMS_SIGN_NAME=
TENCENT_SMS_TEMPLATE_ID=
TENCENT_SMS_REGION=ap-guangzhou
TENCENT_SMS_TOKEN=
SMS_CODE_SECRET=
SMS_DAILY_LIMIT=100
```

上例保持关闭。只有配置实际值后才按维护流程启用并重启；必要字段不完整时不能启用。`TENCENT_SMS_TOKEN` 可用于临时凭据；`SMS_CODE_SECRET` 是独立、至少 32 字节的验证码 HMAC 密钥，不能复用供应商 SecretKey、SMTP 或模型密钥。密钥不得进入 `VITE_`、构建包、静态资源、日志或 Git。

适配器使用腾讯云 `SendSms`，模板参数只有一个验证码变量，审核模板须与之匹配；应用验证码有效期 5 分钟。服务端先持久化发送预占、供应商确认提交后才允许消费，60 秒冷却、单号每小时 5 条/24 小时 10 条、单 IP 标签每小时 10 条/24 小时 30 条、全局 `SMS_DAILY_LIMIT` 默认 100 次/24 小时、最多 2 个并发和 5 次错误锁定。失败提交也计入发送限额；本地超时不代表供应商未计费，不自动重试。配置启用检查与供应商接受不代替真实手机收件验收。

`phoneChallenges` 增量保存在旧版本 3 的私有账号 JSON；缺失字段补空，旧邮箱账号、会员和微信绑定继续保留。phone-only 账号没有伪造邮箱或密码，因此启用并产生此类账号后，旧版程序可能无法读取当前数据。回退前必须使用目标旧版本只读验证兼容性，保留受限数据备份，不覆盖上线后的新账号或简历，也不能通过删除手机号字段恢复旧版假设。

同账号绑定的接口、当前身份证明、数据隔离与错误分支见 [手机号与短信](phone-auth.md)。测试使用假发送器，不产生真实短信或费用；真实发码必须另有用户授权号码，页面效果与微信真机仍由用户另行验收。

## 支付配置

服务器 `/etc/resume-youfang/runtime.env` 设为 `0600`，另在 `/etc/resume-youfang/wechat-pay/` 下放置微信商户 API 私钥与微信支付平台公钥，在 `/etc/resume-youfang/alipay/` 下放置支付宝应用私钥与支付宝公钥；文件和目录仅允许服务运行用户读取。所需变量、回调地址和验收步骤见 [微信支付与支付宝网页支付接入](payment.md)。

微信支付与支付宝可分别配置、分别启用：微信配置缺失不影响支付宝网页支付，反之亦然；但同一渠道只配置一部分会让服务启动失败，避免出现“看似可支付但实际不可用”的状态。新增或修改支付配置后重启服务，并确认 `/api/v1/membership` 的 `paymentAvailable`、`/api/v1/billing/payment-methods` 与 `/api/v1/plans` 价格符合预期。密钥不得写入本仓库、静态文件、构建产物、日志或聊天；不要用构建成功代替真实小额支付验收。

## 仅回滚前端

当前 Nginx 的静态目录为 `current/www`，API 同样随 `current` 选择发布版本，因此直接把 `current` 指向旧目录会同时回退前后端。只回滚前端时，创建新的发布目录，沿用当前版本的 API 与运行依赖，选取已保留旧版本的 `www`，记录前端与后端各自的来源提交，再按发布校验和激活流程发布。保持资源文件完整成套，不能只替换首页或混用不同版本的脚本。

前端单独回滚需确认旧页面与当前 API 契约兼容；账号、简历、企业资料和运行配置保留当前状态，不随页面回滚。2026-11-04 的界面与规则建议调整未改变 API 字段，上一版本页面仍可配合当前 API；规则建议生成逻辑位于服务端，仅回滚页面不会回退该逻辑。当前没有独立的前端版本指针或一键前端回滚按钮。
