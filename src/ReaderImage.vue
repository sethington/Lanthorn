<script setup lang="ts">
// A picture a document carries, shown in the reader between its paragraphs. It is read like the editor's preview reads it (see lib/images.ts);
// one that can't be found shows its description instead. The world never sees it.
import { onBeforeUnmount, ref, watch } from "vue";
import { blobUrl, loadImage } from "./lib/images";

const props = defineProps<{ src: string; alt: string; title: string; dir?: string }>();
const emit = defineEmits<{ (e: "settled"): void }>();
const url = ref("");
const missing = ref(false);
let made = "";
watch(() => [props.src, props.dir], async () => {
  const img = await loadImage(props.src, { dir: props.dir });
  if (made) URL.revokeObjectURL(made);
  made = img ? blobUrl(img) : "";
  url.value = made;
  missing.value = !img;
  emit("settled");
}, { immediate: true });
onBeforeUnmount(() => { if (made) URL.revokeObjectURL(made); });
const cap = () => (props.title || props.alt).trim();
</script>

<template>
  <figure class="rimg">
    <img v-if="url" :src="url" :alt="alt" @load="emit('settled')" />
    <div v-else-if="missing" class="rmiss">🖼 {{ alt || "image" }}</div>
    <div v-else class="rwait" />
    <figcaption v-if="cap() && !missing">{{ cap() }}</figcaption>
  </figure>
</template>

<style scoped>
.rimg { margin: 1.4em auto; text-align: center; max-width: 100%; }
.rimg img { max-width: 100%; max-height: 60vh; border-radius: 4px; display: inline-block; }
.rimg figcaption { margin-top: 0.5em; font-size: 0.85em; font-style: italic; opacity: 0.65; }
.rmiss { opacity: 0.5; font-size: 0.9em; padding: 1em; border: 1px dashed currentColor; border-radius: 6px; display: inline-block; }
.rwait { height: 120px; }
</style>
