<script setup lang="ts">
import LegalPage from '../../components/LegalPage.vue';
import { legalConfig } from '../../config/legal';
</script>

<template>
  <LegalPage title="用户协议" :updated-at="legalConfig.updatedAt">
    <view class="legal-section">
      <text class="legal-paragraph">欢迎使用“简历有方”（{{ legalConfig.website }}，以下简称“本网站”）。本网站由 {{ legalConfig.operatorName }}（{{ legalConfig.operatorType }}）运营。本协议是你与我们之间关于注册、使用本网站服务所订立的协议。请在使用前仔细阅读；你注册账号或使用服务，即表示你同意本协议。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">一、服务内容</text>
      <text class="legal-paragraph">本网站提供简历编辑与版本管理、简历检查与修改建议、模板与版式选择、Word/PDF 导出、岗位关键词整理、企业历史招聘资料查询以及求职助手对话等功能。当前会员权益仅为功能预览，线上尚未开通支付与收费服务；如未来开通，会在购买页面明确展示价格、权益与退款规则。</text>
      <text class="legal-paragraph">我们可能根据业务发展调整、增加或下线部分功能，并尽可能提前在站内说明。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">二、账号注册与安全</text>
      <text class="legal-item">1. 你需要使用真实、有效的邮箱地址注册账号，并妥善保管密码与验证码。</text>
      <text class="legal-item">2. 账号仅限你本人使用，不得出借、转让或出售。因你保管不善导致的账号被盗用、信息泄露等后果，由你自行承担；发现异常请及时联系我们。</text>
      <text class="legal-item">3. 你应保证注册信息不侵犯他人合法权益。我们有权对存在异常注册、批量注册或安全风险的账号采取限制措施。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">三、你提交的内容</text>
      <text class="legal-paragraph">你通过本网站填写、粘贴或导入的简历、岗位描述、求职记录等内容（以下统称“用户内容”）归你所有。你应确保用户内容真实、合法，不包含虚假信息、违法信息或侵犯他人知识产权、隐私权、名誉权等内容。</text>
      <text class="legal-paragraph">为向你提供服务，你授予我们在提供服务所必需的范围内存储、处理、展示和导出用户内容的非独占许可；该许可不改变用户内容的权属，也不允许我们将你的简历用于与本服务无关的用途。你删除用户内容或注销账号后，我们按隐私政策处理相关数据。</text>
      <text class="legal-paragraph">你通过本网站生成的导出文件由你自行保管和对外使用。请勿将包含他人隐私或敏感信息的简历内容上传、粘贴或导出。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">四、使用规范</text>
      <text class="legal-paragraph">使用本网站时，你不得实施以下行为：</text>
      <text class="legal-item">1. 违反法律法规、公序良俗，或侵犯他人合法权益；</text>
      <text class="legal-item">2. 未经授权访问、扫描、探测、攻击本网站或相关服务器，或干扰服务正常运行；</text>
      <text class="legal-item">3. 使用爬虫、脚本或其他自动化方式批量抓取企业资料、简历模板或导出内容；</text>
      <text class="legal-item">4. 批量注册账号、绕过频率限制或安全验证，或利用本网站从事欺诈、引流、垃圾信息等活动；</text>
      <text class="legal-item">5. 反向工程、反编译、拆分或试图获取本网站的源代码、接口密钥或未公开数据；</text>
      <text class="legal-item">6. 其他违反本协议或损害本网站及其他用户利益的行为。</text>
      <text class="legal-paragraph">如你违反上述规范，我们有权视情况限制功能、暂停或终止账号，并保留依法追究责任的权利。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">五、企业资料与第三方链接</text>
      <text class="legal-paragraph">企业资料库中的招聘信息来自公开渠道的历史资料整理，可能已经过期、不完整或发生变化，仅供应聘参考，不构成任何企业当前正在招聘、录用条件或录用结果的承诺。投递前请以企业官方渠道发布的信息为准。</text>
      <text class="legal-paragraph">企业资料中可能包含第三方网站链接。第三方网站的内容、服务与信息处理行为由其自行负责，你访问时应遵守该第三方的规则。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">六、简历检查与建议</text>
      <text class="legal-paragraph">本网站的简历检查、匹配关键词和求职助手回复基于本地透明规则生成，不是大模型生成内容，也不代表招聘方、ATS 系统或任何第三方的真实评价。分析结果仅供参考，不构成职业建议、录用承诺或对求职结果的保证。</text>
      <text class="legal-paragraph">建议内容可能需要你补充真实信息后才能应用。你应自行核对建议与原文，不得利用本网站编造公司、学校、日期、经历、技能熟练度、业绩或量化成果。是否采纳建议由你自行决定。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">七、知识产权</text>
      <text class="legal-paragraph">本网站的界面设计、图标、商标、文字说明、程序代码、企业资料整理成果及其他由我们创作的内容，其知识产权归我们或相关权利人所有。未经书面许可，不得复制、修改、传播或用于商业用途。</text>
      <text class="legal-paragraph">你对自己的用户内容享有权利。你向本网站提交反馈、建议时，我们可在不泄露你个人信息的前提下用于改进服务。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">八、服务变更、中断与终止</text>
      <text class="legal-paragraph">我们可能因系统维护、升级、故障、网络攻击、不可抗力或法律法规要求等原因，暂停或中断部分服务，并尽可能提前通知。因上述原因造成的不便或损失，我们在法律允许的范围内不承担责任。</text>
      <text class="legal-paragraph">如你违反本协议，或长期未使用账号，我们可依法依规限制、暂停或终止向你提供服务。你可以随时停止使用本网站，并通过联系我们申请删除数据或注销账号。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">九、免责与责任限制</text>
      <text class="legal-paragraph">本网站按“现状”提供服务。我们会尽力保障服务的稳定与准确，但不对服务不中断、无错误或完全满足你的特定需求作出保证。对于因你自身操作、第三方服务、网络环境、不可抗力等非我们可控原因造成的损失，我们在法律允许的范围内不承担责任。</text>
      <text class="legal-paragraph">本条款不排除或限制我们依法应承担的责任，也不排除你依法享有的权利。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">十、法律适用与争议解决</text>
      <text class="legal-paragraph">本协议的订立、履行与解释适用中华人民共和国法律。因本协议产生的争议，双方应先友好协商；协商不成的，可向有管辖权的人民法院提起诉讼。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">十一、联系我们</text>
      <text class="legal-paragraph">运营主体：{{ legalConfig.operatorName }}（{{ legalConfig.operatorType }}）</text>
      <text class="legal-paragraph">网站：{{ legalConfig.website }}</text>
      <text class="legal-paragraph">备案号：{{ legalConfig.icpLicense }}</text>
      <text v-if="legalConfig.contactEmail" class="legal-paragraph">联系邮箱：{{ legalConfig.contactEmail }}</text>
      <text v-if="legalConfig.contactPhone" class="legal-paragraph">联系电话：{{ legalConfig.contactPhone }}</text>
      <text class="legal-paragraph">如你对本协议有疑问，可通过本网站底部“联系我们”页面所列方式与我们联系。</text>
    </view>
  </LegalPage>
</template>
