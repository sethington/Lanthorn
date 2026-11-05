<script setup lang="ts">
import { computed, ref, watch } from "vue";

// A model picker: a dropdown of known models, "default", and "Custom…" for anything else.
const props = defineProps<{
  modelValue?: string | null;
  options: { value: string; label?: string }[];
  defaultLabel: string;
  loading?: boolean;
}>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void; (e: "change"): void }>();

const CUSTOM = "__custom__";
const value = computed(() => props.modelValue ?? "");
const known = computed(() => props.options.some((o) => o.value === value.value));
const custom = ref(value.value !== "" && !known.value);
watch(
  () => [props.modelValue, props.options],
  () => {
    // a value the list doesn't know (typed earlier, or the list changed) stays editable rather than vanishing
    if (value.value !== "" && !known.value) custom.value = true;
  },
);

const selected = computed(() => (custom.value ? CUSTOM : value.value));

function pick(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  if (v === CUSTOM) {
    custom.value = true;
    return;
  }
  custom.value = false;
  emit("update:modelValue", v);
  emit("change");
}
function typed(e: Event) {
  emit("update:modelValue", (e.target as HTMLInputElement).value.trim());
  emit("change");
}
</script>

<template>
  <div class="ms">
    <select :value="selected" :disabled="loading" @change="pick">
      <option value="">{{ loading ? "Loading models…" : defaultLabel }}</option>
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label ?? o.value }}</option>
      <option :value="CUSTOM">Custom…</option>
    </select>
    <input v-if="custom" :value="value" placeholder="model name" @change="typed" />
  </div>
</template>

<style scoped>
.ms { display: grid; gap: 6px; min-width: 0; }
select, input { background: #0f1115; color: var(--ink); border: 1px solid #2b2f38; border-radius: 8px; padding: 7px 10px; font: 13px system-ui, sans-serif; min-width: 0; }
select:focus, input:focus { outline: 1px solid #c9a54a; border-color: #c9a54a; }
</style>
