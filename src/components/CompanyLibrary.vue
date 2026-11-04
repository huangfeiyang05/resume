<script setup lang="ts">
import { computed, ref } from 'vue';
import { companyFilterKeys } from '../../shared/company';
import type { CompanyFilterKey, CompanyMatchField, CompanyRecord, CompanySort } from '../../shared/types';
import { useCompanyLibrary } from '../services/companies';
import AppIcon from './AppIcon.vue';
import AppModal from './AppModal.vue';

const emit = defineEmits<{ addJob: [company: CompanyRecord] }>();
const c = useCompanyLibrary();
const { query, sort, filters, result, loading, error, notice, pages, filterCount, selectedId, selected, detailLoading, detailError } = c;
defineExpose({ reload: c.reload });
const showFilters = ref(false), expanded = ref<CompanyFilterKey[]>([]);
const labels: Record<CompanyFilterKey, string> = { industries: '行业', natures: '企业性质', locations: '地区', directions: '岗位方向', educationLevels: '学历', recruitmentTypes: '招聘批次', cohorts: '招聘对象' };
const matchLabels: Record<CompanyMatchField, string> = { name: '企业名称', aliases: '别名', industries: '行业', nature: '企业性质', locations: '地区', directions: '岗位方向', educationLevels: '学历', recruitmentTypes: '招聘批次', cohorts: '招聘对象', summary: '资料说明' };
const sorts: Array<{ value: CompanySort; label: string }> = [{ value: 'relevance', label: '文本相关' }, { value: 'name', label: '企业名称' }, { value: 'updated', label: '资料整理时间' }];
const sortIndex = computed(() => Math.max(0, sorts.findIndex(item => item.value === sort.value)));
const activeFilters = computed(() => companyFilterKeys.flatMap(key => filters.value[key].map(value => ({ key, value }))));
function options(key: CompanyFilterKey) {
  const values = result.value?.facets[key] ?? [];
  const missing = filters.value[key].filter(value => !values.some(item => item.value === value)).map(value => ({ value, count: 0 }));
  const list = [...missing, ...values];
  const limit = expanded.value.includes(key) ? 80 : 12;
  return list.filter((item, index) => index < limit || filters.value[key].includes(item.value));
}
function toggleExpanded(key: CompanyFilterKey) { expanded.value = expanded.value.includes(key) ? expanded.value.filter(item => item !== key) : [...expanded.value, key]; }
function pickSort(event: { detail: { value: string | number } }) { void c.setSort(sorts[Number(event.detail.value)]?.value ?? 'relevance'); }
function copy(value: string) {
  uni.setClipboardData({ data: value, success: () => { notice.value = '链接已复制。'; }, fail: () => { notice.value = '复制失败，可手动复制详情中的网址。'; } });
}
function addJob() { if (selected.value) { emit('addJob', selected.value); c.closeDetail(); } }
</script>

<template>
  <view class="company-library">
    <view class="company-caption">历史招聘资料，当前岗位与日期请以企业公告为准。</view>
    <view class="glass-panel company-search">
      <view class="company-search-input"><AppIcon name="search" :size="18" /><input v-model="query" :maxlength="200" placeholder="企业名，或多个关键词，如 北京 国企 软件" aria-label="企业查询关键词" confirm-type="search" @confirm="c.search" /></view>
      <button class="button primary" :disabled="loading" @click="c.search" role="button" tabindex="0">查询</button>
    </view>
    <view class="company-toolbar">
      <button class="text-button" :aria-expanded="showFilters" @click="showFilters = !showFilters" role="button" tabindex="0">分类筛选{{ filterCount ? `（${filterCount}）` : '' }}<AppIcon name="chevron" :size="13" /></button>
      <picker :range="sorts.map(item => item.label)" :value="sortIndex" :disabled="loading" @change="pickSort"><view class="company-sort">{{ sorts[sortIndex].label }}<AppIcon name="chevron" :size="13" /></view></picker>
      <button class="text-button" :disabled="loading" @click="c.clear" role="button" tabindex="0">清除条件</button>
    </view>
    <view v-if="showFilters" class="glass-panel company-filters">
      <text class="company-filter-help">同类多选，不同分类共同筛选。</text>
      <view v-for="key in companyFilterKeys" :key="key" class="company-filter-row"><text class="company-filter-label">{{ labels[key] }}</text><view class="company-filter-options">
        <button v-for="item in options(key)" :key="item.value" class="company-chip" :class="{ active: filters[key].includes(item.value) }" :aria-pressed="filters[key].includes(item.value)" :disabled="loading" @click="c.toggleFilter(key, item.value)" role="button" tabindex="0">{{ item.value }} <text>{{ item.count }}</text></button>
        <text v-if="!options(key).length" class="company-muted">暂无分类信息</text>
        <button v-if="(result?.facets[key].length ?? 0) > 12" class="text-button" @click="toggleExpanded(key)" role="button" tabindex="0">{{ expanded.includes(key) ? '收起' : '展开更多' }}</button>
        <text v-if="expanded.includes(key) && (result?.facets[key].length ?? 0) > 80" class="company-muted">先展示前 80 项，可用关键词缩小范围。</text>
      </view></view>
    </view>
    <view v-if="activeFilters.length" class="company-selected"><button v-for="item in activeFilters" :key="`${item.key}:${item.value}`" class="company-chip active" :disabled="loading" @click="c.toggleFilter(item.key, item.value)" role="button" tabindex="0">{{ labels[item.key] }}：{{ item.value }} ×</button></view>
    <text v-if="notice" class="company-notice" role="status">{{ notice }}</text>
    <view v-if="loading" class="glass-panel company-empty" role="status"><view class="spinner" /><text>正在查询企业资料…</text></view>
    <view v-else-if="error || result?.catalogState === 'unavailable'" class="glass-panel company-empty" role="alert"><text>{{ error || result?.catalogMessage }}</text><button class="button secondary" @click="c.reload" role="button" tabindex="0">重新查询</button></view>
    <template v-else-if="result">
      <view v-if="result.catalogState === 'empty'" class="glass-panel company-empty"><AppIcon name="briefcase" :size="28" /><text>企业资料尚未导入</text><text class="company-caption">可先添加目标岗位。</text></view>
      <view v-else-if="!result.items.length" class="glass-panel company-empty"><text>没有符合条件的企业资料</text><text class="company-caption">可减少关键词，或取消部分分类条件。</text><button class="button secondary" @click="c.clear" role="button" tabindex="0">清除筛选</button></view>
      <template v-else>
        <text class="company-count">共 {{ result.total }} 条企业招聘资料 · 第 {{ result.page }} / {{ pages }} 页</text>
        <view class="company-grid"><button v-for="item in result.items" :key="item.id" class="glass-panel company-card" @click="c.openCompany(item.id)" role="button" tabindex="0"><view class="company-card-heading"><text>{{ item.name }}</text><AppIcon name="chevron" :size="14" /></view><view class="company-tags"><text v-if="item.nature">{{ item.nature }}</text><text v-for="industry in item.industries.slice(0, 2)" :key="industry">{{ industry }}</text><text v-for="location in item.locations.slice(0, 3)" :key="location">{{ location }}</text></view><text v-if="item.directions.length" class="company-body">{{ item.directions.slice(0, 8).join('、') }}</text><text v-if="item.summary" class="company-excerpt">{{ item.summary }}</text><text v-if="item.matchedFields.length" class="company-match">关键词命中：{{ item.matchedFields.map(field => matchLabels[field]).join('、') }}</text></button></view>
        <view class="company-pagination"><button class="button secondary" :disabled="result.page <= 1" @click="c.goToPage(result.page - 1)" role="button" tabindex="0">上一页</button><text>{{ result.page }} / {{ pages }}</text><button class="button secondary" :disabled="result.page >= pages" @click="c.goToPage(result.page + 1)" role="button" tabindex="0">下一页</button></view>
      </template>
    </template>
    <AppModal v-if="selectedId" :title="selected?.name || '企业资料'"  wide @close="c.closeDetail">
      <view v-if="detailLoading" class="company-empty" role="status"><text>正在读取企业详情…</text></view>
      <view v-else-if="detailError" class="company-empty" role="alert"><text>{{ detailError }}</text><button class="button secondary" @click="c.openCompany(selectedId)" role="button" tabindex="0">重试</button></view>
      <template v-else-if="selected">
        <view class="company-detail-fields"><view v-for="key in companyFilterKeys" :key="key"><text selectable>{{ labels[key] }}</text><text class="company-selectable" selectable>{{ key === 'natures' ? selected.nature || '未提供' : selected[key].join('、') || '未提供' }}</text></view></view>
        <text v-if="selected.aliases.length" class="company-body company-selectable" selectable>别名：{{ selected.aliases.join('、') }}</text>
        <text v-if="selected.summary" class="company-prose company-selectable" selectable>{{ selected.summary }}</text>
        <view v-if="selected.recruitmentUrl" class="company-detail-source"><text selectable>招聘资料链接</text><text class="company-url" selectable>{{ selected.recruitmentUrl }}</text><button class="text-button" @click="copy(selected.recruitmentUrl)" role="button" tabindex="0">复制招聘链接<AppIcon name="copy" :size="14" /></button></view>
        <view class="company-detail-footer"><button class="button primary" @click="addJob" role="button" tabindex="0">添加目标岗位<AppIcon name="plus" :size="14" /></button></view>
      </template>
    </AppModal>
  </view>
</template>

<style scoped>
.company-caption,.company-body,.company-filter-help{font-size:14px;color:#536174;line-height:1.8}.company-caption{display:block;margin-bottom:18px}.company-search,.company-search-input,.company-toolbar,.company-sort,.company-card-heading,.company-pagination{display:flex;align-items:center;gap:14px}.company-search{padding:14px 17px}.company-search-input{flex:1;min-width:0}.company-search-input input{flex:1;min-width:0;font-size:16px}.company-search>.button{min-height:38px;font-size:14px}.company-toolbar{margin:15px 0;flex-wrap:wrap}.company-toolbar>.text-button:first-child{margin-right:auto}.company-sort{font-size:14px;color:#536174}.company-filters{padding:18px;margin-bottom:15px}.company-filter-help{display:block;margin-bottom:13px}.company-filter-row{display:flex;gap:14px;margin:13px 0}.company-filter-label{font-size:14px;color:#536174;flex:0 0 58px;line-height:28px}.company-filter-options,.company-selected,.company-tags{display:flex;gap:7px;flex-wrap:wrap}.company-chip{font-size:13px;line-height:1.7;border:1px solid #d8dfe8;border-radius:8px;padding:5px 9px;color:#536174;background:#f4f6f9;text-align:left;min-height:36px}.company-chip text{color:#536174}.company-chip.active{color:#2458c5;border-color:#9eb3e3;background:#eaf0fc}.company-muted{font-size:13px;color:#536174;line-height:28px}.company-selected{margin:14px 0}.company-notice{display:block;font-size:14px;color:#246347;line-height:1.8;margin:14px 0}.company-empty{padding:30px;display:flex;flex-direction:column;align-items:center;gap:15px;text-align:center;color:#536174;font-size:15px;line-height:1.8}.company-empty .company-caption{margin:0}.company-count{display:block;font-size:14px;color:#536174;margin:18px 0 12px}.company-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.company-card{display:block;text-align:left;padding:22px;min-width:0}.company-card-heading{justify-content:space-between;font-size:18px;color:#1f2937;font-weight:600;line-height:1.6}.company-tags{margin:12px 0}.company-tags>text{font-size:12px;color:#536174;background:#f4f6f9;border-radius:6px;padding:4px 7px}.company-body{display:block}.company-excerpt{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;font-size:14px;color:#536174;line-height:1.8;margin-top:10px}.company-match{display:block;font-size:12px;color:#536174;line-height:1.8;margin-top:12px}.company-match{color:#536174}.company-pagination{justify-content:center;margin:23px 0;font-size:14px;color:#536174}.company-pagination .button{min-height:38px;font-size:14px}.company-detail-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px;margin-bottom:22px}.company-detail-fields>view{display:flex;flex-direction:column;gap:6px;font-size:14px;line-height:1.8;min-width:0}.company-detail-fields>view>text:first-child{color:#536174;font-size:13px}.company-detail-fields>view>text:last-child{color:#536174;white-space:pre-wrap;overflow-wrap:anywhere}.company-prose{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.9;color:#1f2937;margin:19px 0}.company-detail-source{border-top:1px solid #d8dfe8;padding-top:15px;margin-top:18px;display:flex;flex-direction:column;gap:8px;font-size:13px;color:#536174;line-height:1.8}.company-url{color:#2458c5;word-break:break-all;user-select:text;-webkit-user-select:text}.company-selectable{user-select:text;-webkit-user-select:text;overflow-wrap:anywhere;white-space:pre-wrap}.company-detail-footer{display:flex;align-items:center;gap:15px;margin-top:25px;justify-content:flex-end}.company-detail-footer>text{font-size:13px;line-height:1.8;color:#536174;flex:1}.company-detail-footer>.button{font-size:14px;flex-shrink:0}.company-filters .text-button{font-size:13px}
@media(max-width:767px){.company-grid,.company-detail-fields{grid-template-columns:minmax(0,1fr)}.company-card{padding:18px 16px}.company-filter-row{flex-direction:column;gap:5px}.company-filter-label{flex:auto}.company-detail-footer{flex-wrap:wrap;justify-content:flex-end}.company-detail-footer>text{flex-basis:100%}.company-detail-footer>.button{margin-left:auto}.company-search{padding:12px;gap:9px;align-items:center}.company-search-input{gap:8px}.company-search-input input{font-size:16px;min-width:0;min-height:40px}.company-empty{padding:25px 18px}.company-search > .button{min-height:42px;padding:9px 13px;white-space:nowrap}.company-toolbar{gap:8px 12px;align-items:center}.company-toolbar > .text-button:first-child{margin-right:0}.company-toolbar > picker{margin-left:auto;max-width:100%}.company-sort{min-height:40px;font-size:13px;gap:6px;white-space:nowrap}.company-toolbar > .text-button{min-height:40px;white-space:nowrap}.company-filters{padding:14px}.company-filter-options{min-width:0}.company-chip{min-height:40px;max-width:100%;overflow-wrap:anywhere}.company-card-heading{align-items:flex-start;gap:9px;font-size:17px}.company-card-heading > text{flex:1;min-width:0;overflow-wrap:anywhere}.company-pagination{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;margin:20px 0}.company-pagination .button{min-width:0;min-height:42px;padding:9px 10px}.company-pagination > text{white-space:nowrap;text-align:center}.company-detail-footer > .button{width:100%;min-height:44px}}
.company-card:hover{border-color:#9eb3e3}
.company-chip:hover{border-color:#9eb3e3}
.company-body{font-size:15px;color:#364152}
</style>
