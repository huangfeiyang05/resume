<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Analysis, AnalysisSuggestion, Resume } from '../../shared/types';
import AppIcon from './AppIcon.vue';
const props = defineProps<{ analysis: Analysis; resume: Resume; history: Analysis[]; busy?: string }>();
const emit = defineEmits<{ inspect: [suggestion: AnalysisSuggestion]; export: []; history: [analysis: Analysis]; reanalyze: [] }>();
const issueFilter = ref('all');
const visibleIssues = computed(() => props.analysis.issues.filter(issue => issueFilter.value === 'all' || issue.severity === issueFilter.value));
const highIssueCount = computed(() => props.analysis.issues.filter(issue => issue.severity === 'high').length);
const analysisStale = computed(() => props.analysis.resumeRevision !== props.resume.revision);
const priorityLabels = { eligibility: '资格需核对', required: '任职要求', preferred: '加分条件', review: '待核对条目' };
const formatDate = (date: string) => new Date(date).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
</script>
<template>
  <view class="report-section">
    <view class="flow-section-header"><view><text class="flow-section-title">诊断报告</text></view><button class="text-button" :disabled="!!busy" @click="emit('reanalyze')" role="button" tabindex="0">重新诊断<AppIcon name="undo" :size="15" /></button></view>
    <view v-if="analysisStale" class="info-banner"><AppIcon name="info" :size="17" /><text>简历已更新，当前报告基于 V{{ analysis.resumeRevision }}，可重新诊断查看变化。</text></view>
    <view v-if="analysis.jobReview" class="panel job-review">
      <text class="panel-title">投递前逐条核对</text>
      <text class="field-caption">以下取自本次岗位描述。简历原文仅按词语定位，请亲自核对资格、熟练程度及项目证据。</text>
      <view v-for="(item, index) in analysis.jobReview.items" :key="item.requirement + index" class="job-review-row">
        <text class="job-review-label">{{ priorityLabels[item.priority] }}</text>
        <text selectable>{{ item.requirement }}</text>
        <text v-if="item.priority === 'eligibility'" class="field-caption">请按招聘公告确认毕业时间、学历、证书或年限。</text>
        <view v-for="evidence in item.evidence" :key="evidence.term" class="evidence-block">
          <text class="evidence-caption">{{ evidence.term }} · {{ evidence.excerpt ? '相关简历原文' : '未定位到对应原文' }}</text>
          <text v-if="evidence.excerpt" class="evidence-text" selectable>{{ evidence.excerpt }}</text>
          <text v-else-if="item.priority !== 'eligibility'" class="field-caption">如确有相关经历，补充本人负责的部分和可核对的交付。</text>
        </view>
        <text v-if="!item.evidence.length && item.priority !== 'eligibility'" class="field-caption">请逐项核对，并回看能说明这项要求的真实经历。</text>
      </view>
      <text v-if="analysis.jobReview.omitted" class="field-caption">另有 {{ analysis.jobReview.omitted }} 条请回看岗位描述。</text>
    </view>
    <view v-if="analysis.roleGuide" class="panel job-review">
      <text class="panel-title">准备经历证据</text>
      <text v-for="question in analysis.roleGuide.questions" :key="question" selectable>{{ question }}</text>
      <text class="field-caption">简历有方原创 · {{ analysis.roleGuide.title }} · {{ analysis.roleGuide.version }}</text>
    </view>
<view class="diagnosis-grid"><view class="diagnosis-main"><view class="panel diagnosis-summary"><view class="panel-heading"><text class="panel-title">诊断概览</text><view class="tag">{{ analysis.engine === 'bailian' ? 'AI 建议 · 待核实' : '规则诊断' }}</view></view><text class="summary-text">{{ analysis.summary }}</text><view class="summary-meta"><AppIcon name="clock" :size="14" /><text>{{ formatDate(analysis.createdAt) }} · V{{ analysis.resumeRevision }} · {{ analysis.engine === 'bailian' ? analysis.modelRun?.model : '原文检查' }}</text></view></view><view class="issues-heading"><text class="panel-title">问题清单 <text class="count-label">{{ analysis.issues.length }}</text></text><view class="segmented"><button :class="{ active: issueFilter === 'all' }" @click="issueFilter = 'all'" role="button" tabindex="0">全部</button><button :class="{ active: issueFilter === 'high' }" @click="issueFilter = 'high'" role="button" tabindex="0">优先修改</button><button :class="{ active: issueFilter === 'medium' }" @click="issueFilter = 'medium'" role="button" tabindex="0">继续完善</button></view></view><view v-if="!visibleIssues.length" class="empty-state compact-empty"><AppIcon name="check" :size="28" /><text class="empty-title">该分类暂无问题</text></view><view v-for="(issue, index) in visibleIssues" :key="issue.id" class="panel issue-card"><view class="issue-top"><view class="issue-number">{{ String(index + 1).padStart(2, '0') }}</view><text class="issue-title">{{ issue.title }}</text><view class="priority-tag" :class="issue.severity">{{ issue.severity === 'high' ? '优先修改' : issue.severity === 'medium' ? '继续完善' : '细节建议' }}</view></view><text class="issue-description">{{ issue.description }}</text><view v-if="issue.evidence" class="evidence-block"><text class="evidence-caption">你的原文</text><text class="evidence-text">“{{ issue.evidence }}”</text></view><view class="issue-advice"><AppIcon name="bulb" :size="17" /><text>{{ issue.suggestion }}</text></view><text v-if="issue.guideReference && analysis.roleGuide" class="field-caption">参考 {{ analysis.roleGuide.title }} · {{ analysis.roleGuide.version }}</text></view>
                <view v-if="analysis.suggestions.length" class="section-heading suggestions-heading"><view><text class="section-title">修改建议</text><text class="section-description">核对原文与建议，确认后采纳。</text></view></view><view v-for="suggestion in analysis.suggestions" :key="suggestion.id" class="panel suggestion-card"><view class="suggestion-card-main"><view><text class="issue-title">{{ suggestion.title }}</text><view class="suggestion-source"><text class="suggestion-source-label">原文</text><text class="suggestion-source-text" selectable>{{ suggestion.original }}</text></view><text class="suggestion-reason">{{ suggestion.reason }}</text><text v-if="suggestion.guideReference && analysis.roleGuide" class="field-caption">参考 {{ analysis.roleGuide.title }} · {{ analysis.roleGuide.version }}</text></view></view><button class="button secondary small-button" :disabled="suggestion.applied || !!busy" @click="emit('inspect', suggestion)" role="button" tabindex="0">{{ suggestion.applied ? '已采纳' : '查看并修改' }}<AppIcon :name="suggestion.applied ? 'check' : 'arrow'" :size="15" /></button></view>
              </view><view class="diagnosis-aside"><view class="panel score-panel"><text class="score-panel-title">简历表达参考分</text><view class="score-circle" :style="{ background: `conic-gradient(#2458c5 ${analysis.score * 3.6}deg, #edf0f4 0deg)` }"><view class="score-inner"><text class="score-number">{{ analysis.score }}</text><text class="score-outof">/ 100</text></view></view><text class="score-description">{{ highIssueCount ? `${highIssueCount} 个问题，值得优先关注` : '暂无高优先级问题' }}</text><view class="dimension-list"><view v-for="dimension in analysis.dimensions" :key="dimension.key" class="dimension-item"><view class="dimension-top"><text>{{ dimension.label }}</text><text>{{ dimension.score }}</text></view><view class="dimension-track"><view :style="{ width: `${dimension.score}%` }" /></view></view></view><text class="score-disclaimer">规则参考分，不预测录用。</text></view><view v-if="analysis.keywords.matched.length || analysis.keywords.missing.length" class="panel keywords-panel"><text class="panel-title">岗位关键词</text><text class="keyword-caption">已出现 · 仅文本覆盖</text><view class="keyword-list"><text v-for="word in analysis.keywords.matched" :key="word" class="keyword matched">{{ word }}</text><text v-if="!analysis.keywords.matched.length" class="subtle">暂无已匹配关键词</text></view><text class="keyword-caption">未出现 · 请核对实际经历</text><view class="keyword-list"><text v-for="word in analysis.keywords.missing" :key="word" class="keyword missing">{{ word }}</text><text v-if="!analysis.keywords.missing.length" class="subtle">暂未发现关键词缺口</text></view></view><view class="report-export"><button class="button secondary full-width" @click="emit('export')" role="button" tabindex="0"><AppIcon name="download" :size="16" />预览与导出</button></view><view v-if="history.length > 1" class="history-list"><text class="field-caption">最近诊断</text><button v-for="item in history.slice(0, 4)" :key="item.id" class="history-item" :class="{ selected: analysis.id === item.id }" @click="emit('history', item)" role="button" tabindex="0"><text>V{{ item.resumeRevision }} · {{ formatDate(item.createdAt) }}</text><text>{{ item.score }} 分</text></button></view></view></view>
  </view>
</template>

<style scoped>
.job-review { display: grid; gap: 10px; margin-bottom: 16px; }
.job-review-row { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid #edf0f4; }
.job-review-label { color: #2458a6; font-size: 13px; font-weight: 600; }
</style>
