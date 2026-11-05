<script setup lang="ts">
// A step with a bar: what is happening, how far along (a bar that fills, or one that sweeps when how far is unknown), and a detail line.
defineProps<{ title: string; detail?: string; value?: number; big?: boolean }>();
</script>

<template>
  <div class="prog" :class="{ big }">
    <div class="ptitle">{{ title }}</div>
    <div class="bar" :class="{ sweep: value === undefined }"><i :style="value === undefined ? undefined : { width: Math.round(Math.min(1, Math.max(0, value)) * 100) + '%' }" /></div>
    <div v-if="detail" class="pdetail">{{ detail }}</div>
  </div>
</template>

<style scoped>
.prog { display: grid; gap: 6px; min-width: 150px; font: 11px ui-monospace, Menlo, monospace; color: #b8bcc6; }
.prog.big { min-width: 240px; gap: 9px; font-size: 13px; text-align: center; }
.ptitle { color: #e9e6dd; }
.pdetail { color: #8b8f99; font-size: 0.92em; }
.bar { position: relative; height: 3px; border-radius: 3px; background: #23262d; overflow: hidden; }
.big .bar { height: 4px; }
.bar i { position: absolute; left: 0; top: 0; bottom: 0; background: #c9a54a; border-radius: 3px; transition: width 0.4s ease; }
.bar.sweep i { width: 34%; animation: sweep 1.3s ease-in-out infinite; }
@keyframes sweep { 0% { left: -34%; } 100% { left: 100%; } }
</style>
