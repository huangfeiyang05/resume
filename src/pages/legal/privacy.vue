<script setup lang="ts">
import LegalPage from '../../components/LegalPage.vue';
import { legalConfig } from '../../config/legal';
</script>

<template>
  <LegalPage title="隐私政策" :updated-at="legalConfig.updatedAt">
    <view class="legal-section">
      <text class="legal-paragraph">“简历有方”（{{ legalConfig.website }}，以下简称“本网站”）由 {{ legalConfig.operatorName }}（{{ legalConfig.operatorType }}，以下简称“我们”）运营。我们重视你的个人信息保护，并按照《中华人民共和国个人信息保护法》等法律法规处理你的个人信息。本政策说明我们收集哪些信息、如何使用与保存、与谁共享，以及你可以如何行使权利。</text>
      <text class="legal-paragraph">使用本网站前，请仔细阅读本政策。你注册账号、使用简历编辑、分析、导出或求职助手等功能，即表示你已理解本政策所述的信息处理规则。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">一、我们收集的信息</text>
      <text class="legal-paragraph">我们只收集为你提供服务所必需的信息，主要包括：</text>
      <text class="legal-item">1. 账号信息：你选择邮箱方式时提交的邮箱地址、密码（仅以不可逆的加盐散列值保存，不保存明文密码）和邮箱验证状态；你选择手机号验证码登录、注册或绑定时提交的手机号和验证状态。未绑定的手机号或邮箱不会被虚构补齐，同一账号可绑定两个登录标识。验证码仅用于本次身份核验，服务端保存与号码、用途及挑战标识绑定的散列值，不保存明文验证码。H5 端的登录会话标识保存在 HttpOnly Cookie 中，小程序端以 Bearer 令牌形式随请求发送。</text>
      <text class="legal-item">2. 简历与求职信息：你主动填写或粘贴的简历标题、目标岗位、简历正文、模板与版式选择、版本历史、诊断结果、建议内容、投递计划、收藏以及求职助手对话内容。</text>
      <text class="legal-item">3. 文件导入：H5 端导入 PDF、Word、TXT 简历时，文件在你的浏览器本机解析，原文件不会上传到服务器；解析出的文本仅在你保存或提交分析时发送到服务端。小程序端不提供本地文件解析能力，以粘贴文本方式录入。</text>
      <text class="legal-item">4. 企业资料检索：你输入的关键词、筛选条件与分页参数，用于返回匹配结果；我们不用这些信息建立你的个人画像。</text>
      <text class="legal-item">5. 运行与安全信息：IP 地址、请求时间、浏览器或设备类型、页面错误等信息，用于保障服务稳定与安全、排查故障。我们不把完整简历正文、手机号、密码或邮箱及短信验证码写入应用日志。</text>
      <text class="legal-item">6. 本地存储：为保持登录状态、界面偏好和求职助手历史，我们会在你的浏览器或设备本地保存必要数据。你可以通过浏览器或小程序设置清除这些本地数据，但可能影响登录状态与历史记录。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">二、我们如何使用信息</text>
      <text class="legal-paragraph">我们使用上述信息用于：创建与验证账号、保存与管理简历及版本、提供本地规则形式的简历检查与建议、生成 Word/PDF 导出文件、提供企业资料查询与求职助手、保障账号与系统安全、响应你的咨询、投诉与权利请求，以及履行法律法规规定的义务。</text>
      <text class="legal-paragraph">我们不会将你的个人信息用于与上述目的无关的自动化决策，不会出售你的个人信息，也不会仅依据规则分析结果作出对你有重大影响的决定。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">三、第三方服务与信息共享</text>
      <text class="legal-paragraph">为提供服务，我们可能委托以下类型的服务商处理必要信息：</text>
      <text class="legal-item">1. 云服务器与数据库托管：腾讯云（中国境内），用于存储账号与简历数据、运行网站服务。</text>
      <text class="legal-item">2. 邮件发送服务：用于发送注册、找回密码等验证码邮件；我们仅向邮件服务商提供收件邮箱和邮件内容。</text>
      <text class="legal-item">短信发送服务：仅在你主动选择短信验证并提交手机号后，用于发送登录、注册、账号绑定或身份核验验证码。我们会向配置的短信服务商提供接收手机号、验证码和必要的签名模板参数，不提供你的简历内容。短信入口是否开放以页面提示为准，未配置时不会发送短信。</text>
      <text class="legal-item">3. 第三方招聘链接：企业资料中可能包含指向第三方网站的招聘链接，访问后适用该第三方的隐私政策，我们不控制其信息处理行为。</text>
      <text class="legal-paragraph">当前线上服务使用本地透明规则完成简历检查与求职助手回复，默认不启用第三方大模型处理你的简历。若未来启用第三方模型服务，我们会在使用前单独告知处理目的、涉及的信息字段与服务商，并依法取得你的同意。</text>
      <text class="legal-paragraph">除取得你的同意、履行法定义务、司法机关或监管部门依法要求，或为保护你或他人的生命、财产安全所必需外，我们不会向第三方提供你的简历等个人信息。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">四、存储地点与保存期限</text>
      <text class="legal-paragraph">你的个人信息存储于中华人民共和国境内的服务器。我们仅在实现本政策所述目的所必需的期限内保留你的信息：账号存续期间保留账号与简历数据；你删除简历后，相应内容不再用于服务展示；你申请注销账号后，我们将删除或匿名化处理你的个人信息，法律法规要求保留的除外。</text>
      <text class="legal-paragraph">为保障数据安全与故障恢复，服务器可能保留短期备份副本；备份中的信息会在备份周期结束后按运维规则覆盖或删除。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">五、我们如何保护信息</text>
      <text class="legal-paragraph">我们采取 HTTPS 传输、密码散列保存、登录会话鉴权、按用户隔离简历数据、服务端最小权限与日志脱敏等措施保护你的信息。但互联网环境不存在绝对安全，请妥善保管账号密码，不要向他人泄露验证码。</text>
      <text class="legal-paragraph">如发生个人信息泄露、篡改或丢失，我们将按照法律法规要求及时采取补救措施，并以适当方式告知你，必要时向监管部门报告。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">六、你的权利</text>
      <text class="legal-paragraph">在法律法规允许的范围内，你有权访问、复制、更正、补充和删除你的个人信息，撤回同意，获取个人信息副本，注销账号，以及要求我们解释个人信息处理规则。简历内容与版本可以在网站内直接修改或删除。</text>
      <text class="legal-paragraph">账号注销功能尚在完善中；如需注销账号或行使其他权利，请通过本网站底部“联系我们”页面所列方式提出。为保护账号安全，我们可能要求你使用注册邮箱发送请求并完成必要的身份核验。我们将在 {{ legalConfig.responseDays }} 个工作日内答复。</text>
      <text class="legal-paragraph">如你认为我们的处理行为损害了你的合法权益，可以向网信、市场监管等监管部门投诉或举报。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">七、未成年人保护</text>
      <text class="legal-paragraph">本网站面向有求职、实习或简历整理需求的用户。不满十四周岁的未成年人不得注册和使用本服务；已满十四周岁未满十八周岁的未成年人，应在监护人同意和指导下使用，并由监护人帮助理解本政策。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">八、本政策的更新</text>
      <text class="legal-paragraph">我们可能根据业务变化或法律法规要求更新本政策。更新后的政策将在本页面发布，并标注更新日期；涉及处理目的、信息类型或共享对象等重大变更时，我们会通过站内提示等显著方式告知你，必要时重新取得你的同意。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">九、联系我们</text>
      <text class="legal-paragraph">运营主体：{{ legalConfig.operatorName }}（{{ legalConfig.operatorType }}）</text>
      <text class="legal-paragraph">网站：{{ legalConfig.website }}</text>
      <text class="legal-paragraph">备案号：{{ legalConfig.icpLicense }}</text>
      <text v-if="legalConfig.contactEmail" class="legal-paragraph">联系邮箱：{{ legalConfig.contactEmail }}</text>
      <text v-if="legalConfig.contactPhone" class="legal-paragraph">联系电话：{{ legalConfig.contactPhone }}</text>
      <text class="legal-paragraph">你也可通过本网站底部“联系我们”页面查看最新的联系方式。我们通常会在 {{ legalConfig.responseDays }} 个工作日内回复你的个人信息相关请求。</text>
    </view>
  </LegalPage>
</template>
