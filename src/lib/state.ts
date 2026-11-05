import { computed, ref } from "vue";
import { api, inTauri, type Settings } from "./api";

// shared across the reader and the settings page
export const settings = ref<Settings | null>(null);
export const lastModel = ref<string>(""); // the model that actually answered the last scene call

export async function reloadSettings() {
  if (!inTauri) return;
  try {
    settings.value = await api.settingsLoad();
  } catch (e) {
    console.error(e);
  }
}

export async function saveSettings(next: Settings) {
  await api.settingsSave(next);
  settings.value = next;
}

/** Short label for the top-right badge: "claude · sonnet". */
export const modelBadge = computed(() => {
  const s = settings.value;
  if (!s) return inTauri ? "…" : "no LLM (browser)";
  const route = s.routing["scene"];
  const p = route && s.providers.find((x) => x.id === route.provider);
  if (!p) return "no model set";
  const asked = route.model || p.model || "";
  const shown = lastModel.value || asked || "default";
  return `${p.cli ?? p.name} · ${shown.replace(/^claude-/, "")}`;
});
