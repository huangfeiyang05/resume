<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CareerRecruitmentPortal } from '../../shared/types';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ portals: CareerRecruitmentPortal[]; catalogState: 'empty' | 'ready' | 'unavailable'; catalogMessage: string; loading: boolean }>();
const emit = defineEmits<{ addJob: [portal: CareerRecruitmentPortal]; retry: [] }>();
const query = ref(''), major = ref(''), notice = ref('');
const majors = computed(() => ['', ...new Set(props.portals.flatMap(item => item.majors))].sort());
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return props.portals.filter(item => (!major.value || item.majors.includes(major.value))
    && (!keyword || `${item.organization} ${item.audience} ${item.majors.join(' ')} ${item.description}`.toLowerCase().includes(keyword)));
});
function pickMajor(event: { detail: { value: string | number } }) { major.value = majors.value[Number(event.detail.value)] || ''; }
function checkedDate(value: string) { return new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10); }
function copy(portal: CareerRecruitmentPortal) {
  notice.value = '';
  uni.setClipboardData({ data: portal.sourceUrl,
    success: () => { notice.value = '官方链接已复制。'; },
    fail: () => { notice.value = '复制失败，可手动复制卡片中的网址。'; },
  });
}
</script>

<template>
  <view class="recruitment-portals">
    <view class="portal-heading"><text>官方招聘入口</text><text>{{ portals.length }} 个入口</text></view>
    <text class="portal-caption">入口供查阅，当前岗位以机构公告为准。</text>
    <view class="glass-panel portal-filters">
      <input v-model="query" placeholder="搜索机构、专业或招聘类型" :maxlength="100" aria-label="搜索官方招聘入口" />
      <picker :range="majors.map(value => value || '全部专业')" :value="Math.max(0, majors.indexOf(major))" @change="pickMajor"><view>{{ major || '全部专业' }}<AppIcon name="chevron" :size="13" /></view></picker>
    </view>
    <text v-if="notice" class="portal-notice" role="status" aria-live="polite">{{ notice }}</text>
    <view v-if="catalogState === 'unavailable'" class="glass-panel portal-empty" role="alert"><text>招聘入口暂时无法读取</text><text class="portal-caption">{{ catalogMessage }}</text><button class="text-button" :disabled="loading" @click="emit('retry')" role="button" tabindex="0">{{ loading ? '正在重新读取…' : '重新读取' }}</button></view>
    <view v-else-if="!filtered.length" class="glass-panel portal-empty"><text>{{ portals.length ? '没有符合筛选条件的入口' : '招聘入口待补充' }}</text><button v-if="portals.length" class="text-button" @click="query = ''; major = ''" role="button" tabindex="0">清除筛选</button></view>
    <view v-for="item in filtered" :key="item.id" class="glass-panel portal-card">
      <view class="portal-card-heading"><text>{{ item.organization }}</text><text>{{ item.audience }}</text></view>
      <text class="portal-majors">{{ item.majors.join(' · ') }}</text>
      <text class="portal-description">{{ item.description }}</text>
      <text class="portal-url" selectable>{{ item.sourceUrl }}</text>
      <text class="portal-checked">入口核查：{{ checkedDate(item.checkedAt) }}</text>
      <view class="portal-actions"><button class="text-button" @click="copy(item)" role="button" tabindex="0">复制官方链接<AppIcon name="copy" :size="14" /></button><button class="text-button" @click="emit('addJob', item)" role="button" tabindex="0">添加目标岗位<AppIcon name="plus" :size="14" /></button></view>
    </view>
  </view>
</template>

<style scoped>
.portal-heading,.portal-card-heading,.portal-actions,.portal-filters { display:flex; justify-content:space-between; align-items:center; gap:16px; }
.portal-heading > text:first-child { color:#1f2937; font-size:20px; font-weight:600; }.portal-heading > text:last-child,.portal-card-heading > text:last-child { color:#1f2937; font-size:13px; }
.portal-caption,.portal-description,.portal-majors,.portal-url,.portal-checked { display:block; font-size:14px; line-height:1.9; color:#2458c5; }.portal-caption { margin:10px 0 19px; }
.portal-filters { padding:15px 18px; margin-bottom:19px; }.portal-filters > input { flex:1; min-width:0; font-size:16px; }.portal-filters > picker { font-size:14px; color:#536174; }.portal-filters > picker view { display:flex; align-items:center; gap:10px; }
.portal-card { padding:23px; margin-bottom:14px; }.portal-card-heading > text:first-child { font-size:18px; color:#1f2937; font-weight:600; }.portal-majors { margin:10px 0; color:#536174; }.portal-description { white-space:pre-wrap; }.portal-url { margin-top:12px; color:#2458c5; overflow-wrap:anywhere; word-break:break-all; user-select:text; }.portal-checked { font-size:12px; margin-top:7px; }.portal-actions { justify-content:flex-end; flex-wrap:wrap; margin-top:16px; }.portal-actions .text-button { font-size:14px; }.portal-notice { display:block; font-size:14px; line-height:1.8; color:#246347; margin:10px 0; }.portal-empty { padding:30px; text-align:center; color:#536174; font-size:15px; }.portal-empty .text-button { margin-top:14px; }
@media(max-width:767px) { .portal-filters { flex-wrap:wrap; gap:10px; padding:12px 14px; align-items:stretch; }.portal-filters > input { flex-basis:100%; font-size:16px; min-height:40px; }.portal-card { padding:18px 16px; }.portal-card-heading { align-items:flex-start; flex-wrap:wrap; gap:8px; }.portal-heading > text:first-child { font-size:20px; }.portal-heading { gap:10px; align-items:baseline; }.portal-heading > text:last-child { white-space:nowrap; }.portal-filters > picker { width:100%; min-width:0; }.portal-filters > picker view { min-height:40px; justify-content:space-between; }.portal-card-heading > text:first-child { flex-basis:100%; min-width:0; overflow-wrap:anywhere; font-size:17px; }.portal-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; justify-content:stretch; }.portal-actions .text-button { min-height:42px; font-size:14px; min-width:0; } }
.portal-description{font-size:15px;color:#364152}
</style>
