<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import './styles.css';
// #ifdef H5
function activateButton(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if ((event.key === 'Enter' || event.key === ' ') && target.matches('uni-button[tabindex="0"]')) {
    event.preventDefault();
    if (!target.hasAttribute('disabled') && !target.classList.contains('uni-button-disabled')) target.click();
  }
}
onMounted(() => document.addEventListener('keydown', activateButton));
onUnmounted(() => document.removeEventListener('keydown', activateButton));
// #endif
</script>
<style>
page { background: #f5f5f7; color: #1d1d1f; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif; }
</style>
