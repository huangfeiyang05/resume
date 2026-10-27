<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
</script>
<template><image class="app-icon" :src="`/static/icons/${name}.svg`" :style="{ width: `${size}px`, height: `${size}px` }" mode="aspectFit" /></template>
<style scoped>.app-icon { display: inline-block; flex-shrink: 0; vertical-align: middle; }</style>
