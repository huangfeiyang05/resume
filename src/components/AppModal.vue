<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import AppIcon from './AppIcon.vue';
defineProps<{ title: string; subtitle?: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
// #ifdef H5
let previousFocus: HTMLElement | null = null;
let previousOverflow = '';
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
  if (event.key !== 'Tab') return;
  const nodes = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] input, [role="dialog"] textarea, [role="dialog"] [tabindex="0"]')].filter(node => !node.hasAttribute('disabled') && node.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', keydown);
  setTimeout(() => document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] button')?.focus(), 30);
});
onUnmounted(() => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); previousFocus?.focus(); });
// #endif
</script>
<template>
  <view class="modal-overlay" @click="emit('close')">
    <view class="modal-sheet" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title" @click.stop>
      <view class="modal-heading"><view><text class="modal-title">{{ title }}</text><text v-if="subtitle" class="modal-subtitle">{{ subtitle }}</text></view><button class="icon-button" aria-label="关闭弹窗" @click="emit('close')" role="button" tabindex="0"><AppIcon name="close" /></button></view>
      <slot />
    </view>
  </view>
</template>
