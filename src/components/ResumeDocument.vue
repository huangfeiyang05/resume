<script setup lang="ts">
import { computed } from 'vue'
import type { ResumeExportDocument, ResumeExportTemplate } from '../../shared/resume-layout'
import { getResumeBodySegments, getResumeLayoutColumns } from '../../shared/resume-layout'
import { getResumeSectionKind } from '../utils/resumeSections'

const props = defineProps<{ document: ResumeExportDocument; variant: ResumeExportTemplate }>()

// Column placement changes presentation only; every original heading and body is retained.
const sections = computed(() => props.document.sections.map((section, index) => {
  const kind = getResumeSectionKind(section.title)
  return {
    ...section,
    index,
    kind,
    parts: kind === 'experience' || kind === 'projects'
      ? getResumeBodySegments(section.body)
      : [{ text: section.body, emphasis: false }],
  }
}))
const columns = computed(() => getResumeLayoutColumns(sections.value, props.variant))
</script>

<template>
  <view class="resume-document" :class="[`variant-${variant}`, { 'has-sidebar': columns.sidebar.length > 0 }]" role="article" :aria-label="document.title || '简历预览'">
    <view class="document-columns">
      <view class="document-main">
        <view v-if="document.name || document.role || document.contact?.length" class="document-header" :class="{ 'has-intro': sections[0]?.title === '' }">
          <text v-if="document.name" class="document-name" role="heading" aria-level="1">{{ document.name }}</text>
          <text v-if="document.role" class="document-role">{{ document.role }}</text>
          <view v-if="document.contact?.length" class="document-contact">
            <text v-for="(contact, index) in document.contact" :key="index" class="document-contact-item">{{ contact }}</text>
          </view>
        </view>

        <view v-for="section in columns.main" :key="section.index" class="document-section" :class="[`kind-${section.kind}`, { 'is-untitled': !section.title }]">
          <view v-if="section.title" class="document-section-heading">
            <text class="document-section-title" role="heading" aria-level="2">{{ section.title }}</text>
          </view>
          <text class="document-section-body"><text v-for="(part, partIndex) in section.parts" :key="partIndex" :class="{ 'document-body-label': part.emphasis }">{{ part.text }}</text></text>
        </view>
      </view>

      <view v-if="columns.sidebar.length" class="document-sidebar">
        <view v-for="section in columns.sidebar" :key="section.index" class="document-section" :class="`kind-${section.kind}`">
          <view class="document-section-heading">
            <text class="document-section-title" role="heading" aria-level="2">{{ section.title }}</text>
          </view>
          <text class="document-section-body"><text v-for="(part, partIndex) in section.parts" :key="partIndex" :class="{ 'document-body-label': part.emphasis }">{{ part.text }}</text></text>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.resume-document {
  --document-accent: #202326;
  --document-ink: #30343a;
  --document-muted: #6d737a;
  --document-rule: #c4c8cb;
  box-sizing: border-box;
  width: 100%;
  max-width: 794px;
  min-width: 0;
  min-height: 1123px;
  margin: 0 auto;
  color: var(--document-ink);
  background: #fff;
  border: 1px solid #e2e5e8;
  box-shadow: 0 12px 36px #2635440a;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 13px;
  line-height: 1.85;
}
.document-columns {
  display: flex;
  align-items: stretch;
  min-width: 0;
  min-height: 1121px;
}
.document-main {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 46px 48px 52px;
}
.document-header {
  min-width: 0;
  margin-bottom: 29px;
  padding-bottom: 21px;
  border-bottom: 2px solid var(--document-accent);
}
.document-header.has-intro { margin-bottom: 14px; }
.document-name,
.document-role,
.document-contact-item,
.document-section-title,
.document-section-body {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.document-name {
  display: block;
  color: var(--document-accent);
  font-size: 34px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 2px;
}
.document-role {
  display: block;
  margin-top: 8px;
  color: var(--document-accent);
  font-size: 15px;
  font-weight: 500;
  line-height: 1.7;
}
.document-contact {
  display: flex;
  flex-wrap: wrap;
  column-gap: 18px;
  row-gap: 3px;
  margin-top: 10px;
}
.document-contact-item {
  display: block;
  max-width: 100%;
  color: var(--document-muted);
  font-size: 11px;
  line-height: 1.8;
}
.document-section { min-width: 0; margin-bottom: 24px; }
.document-section:last-child { margin-bottom: 0; }
.document-section-heading {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 0 6px;
  border-bottom: 1px solid var(--document-rule);
}
.document-section-title {
  display: block;
  color: var(--document-accent);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.7;
  letter-spacing: 1.6px;
}
.document-section-body {
  display: block;
  box-sizing: border-box;
  padding-top: 10px;
  font-size: 13px;
  line-height: 1.9;
}
.document-body-label { color: inherit; font-weight: 700; }
.kind-experience .document-section-body::first-line,
.kind-projects .document-section-body::first-line { font-weight: 700; }
.is-untitled .document-section-body { padding-top: 0; color: var(--document-muted); }
.document-sidebar {
  box-sizing: border-box;
  flex: 0 0 29%;
  min-width: 0;
  padding: 48px 24px 42px;
}
.document-sidebar .document-section { margin-bottom: 31px; }
.document-sidebar .document-section:last-child { margin-bottom: 0; }
.document-sidebar .document-section-title { font-size: 13px; letter-spacing: 1px; }
.document-sidebar .document-section-body { font-size: 12px; line-height: 1.95; }
.variant-minimal .document-name,
.variant-minimal .document-section-title {
  font-family: 'Songti SC', 'Noto Serif CJK SC', 'SimSun', serif;
}
.variant-minimal .document-header { text-align: center; border-bottom-width: 1px; padding-bottom: 24px; }
.variant-minimal .document-contact { justify-content: center; }
.variant-minimal .document-name { font-size: 35px; letter-spacing: 4px; }
.variant-minimal .document-section-heading { border-bottom-color: #2d3034; }
.variant-modern {
  --document-accent: #285c78;
  --document-muted: #6b7c88;
  --document-rule: #bdd2df;
}
.variant-modern.has-sidebar .document-main { padding: 45px 34px 48px; }
.variant-modern .document-header { padding-bottom: 23px; border-bottom: 0; margin-bottom: 28px; }
.variant-modern .document-name { letter-spacing: 1px; }
.variant-modern .document-section-heading { border-bottom: 0; padding-bottom: 3px; }
.variant-modern .document-section-title { border-left: 3px solid #86b8d4; padding-left: 10px; }
.variant-modern .document-sidebar { order: -1; background: #eaf3f8; border-top: 8px solid #8ebbd3; }
.variant-modern .document-sidebar .document-section-heading { padding-bottom: 7px; border-bottom: 1px solid #b8d0df; }
.variant-modern .document-sidebar .document-section-title { padding-left: 0; border-left: 0; }
.variant-business {
  --document-accent: #17324d;
  --document-muted: #677581;
  --document-rule: #ccd5de;
}
.variant-business.has-sidebar .document-main { padding: 46px 32px 48px 40px; }
.variant-business .document-header { padding-bottom: 23px; border-bottom: 3px solid #17324d; }
.variant-business .document-name { font-size: 35px; letter-spacing: 1px; }
.variant-business .document-section-heading { padding-bottom: 7px; }
.variant-business .document-section-title { letter-spacing: 1.5px; }
.variant-business .document-sidebar {
  flex-basis: 30%;
  padding: 50px 24px 42px;
  color: #e6edf3;
  background: #17324d;
}
.variant-business .document-sidebar .document-section-heading { border-bottom: 1px solid #587087; }
.variant-business .document-sidebar .document-section-title { color: #fff; }
.variant-business .document-sidebar .document-section-body { color: #e6edf3; }
@media (max-width: 600px) {
  .resume-document { min-height: 0; box-shadow: none; }
  .document-columns { min-height: 0; flex-direction: column; }
  .document-main,
  .variant-modern.has-sidebar .document-main,
  .variant-business.has-sidebar .document-main { padding: 28px 22px 32px; }
  .document-header { margin-bottom: 25px; padding-bottom: 18px; }
  .document-name,
  .variant-minimal .document-name,
  .variant-business .document-name { font-size: 29px; }
  .document-role { font-size: 14px; }
  .document-contact { column-gap: 12px; row-gap: 4px; }
  .document-contact-item { font-size: 11px; }
  .document-section { margin-bottom: 22px; }
  .document-section-title { font-size: 13px; letter-spacing: 1px; }
  .document-section-body { font-size: 12px; line-height: 1.95; }
  .document-sidebar,
  .variant-business .document-sidebar { flex-basis: auto; padding: 27px 22px 31px; }
  .variant-modern .document-sidebar { order: 0; border-top: 4px solid #8ebbd3; }
  .document-sidebar .document-section { margin-bottom: 24px; }
}
</style>
