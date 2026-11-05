<script setup lang="ts">
import LegalPage from '../../components/LegalPage.vue';
import { legalConfig } from '../../config/legal';
</script>

<template>
  <LegalPage title="联系我们" :updated-at="legalConfig.updatedAt">
    <view class="legal-section">
      <text class="legal-paragraph">如果你对账号、简历数据、隐私保护、服务使用或本网站内容有任何疑问、意见或投诉，可以通过以下方式联系我们。我们会在 {{ legalConfig.responseDays }} 个工作日内处理并回复。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">运营者信息</text>
      <text class="legal-paragraph">运营主体：{{ legalConfig.operatorName }}（{{ legalConfig.operatorType }}）</text>
      <text class="legal-paragraph">网站地址：{{ legalConfig.website }}</text>
      <text class="legal-paragraph">ICP 备案号：{{ legalConfig.icpLicense }}</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">联系方式</text>
      <text v-if="legalConfig.contactEmail" class="legal-paragraph">联系邮箱：{{ legalConfig.contactEmail }}</text>
      <text v-if="legalConfig.contactPhone" class="legal-paragraph">联系电话：{{ legalConfig.contactPhone }}</text>
      <text v-if="!legalConfig.contactEmail && !legalConfig.contactPhone" class="legal-paragraph legal-pending">联系邮箱与联系电话尚未配置，发布前必须填写真实的联系方式。</text>
      <text class="legal-paragraph">为便于我们核实和处理，请尽量使用注册账号的邮箱发送邮件，并在邮件中说明你的账号邮箱、问题类型与具体诉求。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">个人信息相关请求</text>
      <text class="legal-paragraph">如需查询、更正、删除个人信息，撤回授权，获取个人信息副本或申请注销账号，请通过上述联系方式提出。为保护账号安全，我们可能需要你完成必要的身份核验；注销账号后，我们将按隐私政策删除或匿名化处理你的个人信息，法律法规另有规定的除外。</text>
    </view>

    <view class="legal-section">
      <text class="legal-heading">投诉与建议</text>
      <text class="legal-paragraph">如果你认为本网站的内容或服务侵犯了你的合法权益，或发现企业资料存在错误、过期或不应展示的信息，请提供具体页面、资料名称和说明，我们会尽快核实处理。</text>
      <text class="legal-paragraph">如你对我们的处理结果不满意，也可以向网信、市场监管等监管部门投诉或举报。</text>
    </view>
  </LegalPage>
</template>
