<script setup lang="ts">
import AppIcon from './AppIcon.vue';
defineProps<{ compact?: boolean; modern?: boolean }>();
</script>
<template>
  <view class="resume-art" :class="{ compact, modern }" aria-hidden="true">
    <view class="art-orbit orbit-one" /><view class="art-orbit orbit-two" />
    <view class="art-paper back-paper" />
    <view class="art-paper front-paper">
      <view class="paper-top"><view><view class="paper-name">林沐<text>LIN MU</text></view><view class="paper-role">产品经理 / PRODUCT MANAGER</view></view><view class="paper-monogram">LM</view></view>
      <view class="paper-contact"><view /><view /><view /></view>
      <view v-for="n in 3" :key="n" class="paper-section"><view class="paper-section-title">{{ ['工作经历', '项目经历', '教育背景'][n - 1] }}<view /></view><view class="paper-line dark" /><view class="paper-line" /><view class="paper-line short" /><view v-if="n < 3" class="paper-line" /></view>
      <view class="paper-skills"><view>用户研究</view><view>数据分析</view><view>产品设计</view></view>
    </view>
    <view v-if="!compact" class="art-float float-top"><view class="float-icon"><AppIcon name="sparkles" :size="18" /></view><view><text class="float-title">让亮点，被看见</text><text class="float-sub">把经历写得更有说服力</text></view><view class="float-check">✓</view></view>
    <view v-if="!compact" class="art-float float-bottom"><view class="float-icon green"><AppIcon name="target" :size="18" /></view><view><text class="float-title">每一次投递，都更有方向</text><text class="float-sub">围绕目标岗位，表达你的优势</text></view></view>
  </view>
</template>
