<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api, JOBS, type CacheStats, type Provider, type TestResult } from "./lib/api";
import ModelSelect from "./ModelSelect.vue";
import { engine, setSound, setVolume, soundLevel, soundOn, soundVolume } from "./lib/audio";
import { reloadSettings, saveSettings, settings } from "./lib/state";
import { STYLES, defaultStyle, isStyle, setDefaultStyle } from "./lib/style";
import { judgeSettings, saveJudgeSettings } from "./lib/judge";

const emit = defineEmits<{ (e: "close"): void }>();

const busy = ref("");
const error = ref("");
const tests = reactive<Record<string, TestResult | "running">>({});
const hasKey = reactive<Record<string, boolean>>({});
const keyDraft = reactive<Record<string, string>>({});

const presets = [
  { name: "Ollama", url: "http://localhost:11434/v1" },
  { name: "LM Studio", url: "http://localhost:1234/v1" },
  { name: "llama.cpp server", url: "http://localhost:8080/v1" },
  { name: "vLLM", url: "http://localhost:8000/v1" },
  { name: "Custom (Unsloth, OpenAI, other)", url: "" },
];
const agentDraft = reactive({ cli: "codex", path: "" });
const missing = (cli: string) => !settings.value?.providers.some((p) => p.cli === cli);
const agentNames: Record<string, string> = { claude: "Claude Code", hermes: "Hermes Agent", codex: "Codex CLI" };

async function addAgent() {
  if (!settings.value || !agentDraft.path.trim()) return;
  await run("add-agent", async () => {
    const next = JSON.parse(JSON.stringify(settings.value));
    next.providers = next.providers.filter((x: Provider) => x.id !== `agent-${agentDraft.cli}`);
    next.providers.push({ id: `agent-${agentDraft.cli}`, name: agentNames[agentDraft.cli], kind: "agent", cli: agentDraft.cli, path: agentDraft.path.trim(), manual: true });
    await saveSettings(next);
    agentDraft.path = "";
  });
}

const draft = reactive({ preset: 0, name: "", baseUrl: presets[0].url, model: "", key: "" });

// Claude's CLI takes these aliases; other CLIs don't list their models, so they get "default" and "Custom…".
const CLAUDE_MODELS = [
  { value: "sonnet", label: "Sonnet · balanced" },
  { value: "haiku", label: "Haiku · cheapest" },
  { value: "opus", label: "Opus · most capable" },
];
// endpoints report their own list; fetched on demand
const fetched = reactive<Record<string, string[]>>({});
const fetching = reactive<Record<string, boolean>>({});
const modelErr = reactive<Record<string, string>>({});

function optionsFor(p?: Provider) {
  if (!p) return [];
  if (p.kind === "agent") return p.cli === "claude" ? CLAUDE_MODELS : [];
  return (fetched[p.id] ?? []).map((m) => ({ value: m }));
}
async function loadModels(p: Provider) {
  fetching[p.id] = true;
  modelErr[p.id] = "";
  try {
    fetched[p.id] = await api.endpointModels(p.id);
  } catch (e) {
    modelErr[p.id] = String(e);
  } finally {
    fetching[p.id] = false;
  }
}
// draft endpoint (not saved yet)
const draftModels = ref<string[]>([]);
const draftLoading = ref(false);
const draftErr = ref("");
async function loadDraftModels() {
  draftLoading.value = true;
  draftErr.value = "";
  try {
    draftModels.value = await api.endpointModels(undefined, draft.baseUrl, draft.key || undefined);
  } catch (e) {
    draftErr.value = String(e);
  } finally {
    draftLoading.value = false;
  }
}

const stats = ref<CacheStats | null>(null);
const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
async function loadStats() {
  try { stats.value = await api.cacheStats(); } catch { /* browser */ }
}
async function clearCache(kind: "renders" | "assets" | "analysis") {
  await run("clear", async () => {
    await api.cacheClear(kind);
    await loadStats();
  });
}

onMounted(async () => {
  loadStats();
  await reloadSettings();
  for (const p of settings.value?.providers ?? []) if (p.kind === "endpoint") hasKey[p.id] = await api.secretExists(p.id);
});

async function run<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
  busy.value = label;
  error.value = "";
  try {
    return await f();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = "";
  }
}

async function rescan() {
  await run("scan", async () => {
    settings.value = await api.agentsDetect();
  });
}

async function persist() {
  if (settings.value) await run("save", () => saveSettings(JSON.parse(JSON.stringify(settings.value))));
}

async function test(p: Provider, model?: string) {
  tests[p.id] = "running";
  try {
    tests[p.id] = await api.llmTest(p.id, model);
  } catch (e) {
    tests[p.id] = { ok: false, ms: 0, sample: "", model: "", error: String(e) };
  }
}

function pickPreset() {
  const p = presets[draft.preset];
  draft.baseUrl = p.url;
  if (!draft.name) draft.name = p.url ? p.name : "";
}

async function addEndpoint() {
  if (!settings.value || !draft.baseUrl || !draft.model) return;
  const id = `endpoint-${Date.now().toString(36)}`;
  const p: Provider = { id, name: draft.name || presets[draft.preset].name, kind: "endpoint", baseUrl: draft.baseUrl.trim(), model: draft.model.trim() };
  await run("add", async () => {
    if (draft.key) {
      await api.secretSet(id, draft.key);
      hasKey[id] = true;
    }
    const next = JSON.parse(JSON.stringify(settings.value));
    next.providers.push(p);
    await saveSettings(next);
  });
  draft.name = draft.model = draft.key = "";
}

async function removeProvider(p: Provider) {
  if (!settings.value) return;
  await run("remove", async () => {
    await api.secretDelete(p.id);
    const next = JSON.parse(JSON.stringify(settings.value));
    next.providers = next.providers.filter((x: Provider) => x.id !== p.id);
    for (const j of Object.keys(next.routing)) if (next.routing[j].provider === p.id) delete next.routing[j];
    await saveSettings(next);
  });
}

async function saveKey(p: Provider) {
  const v = keyDraft[p.id];
  if (!v) return;
  await run("key", async () => {
    await api.secretSet(p.id, v);
    hasKey[p.id] = true;
    keyDraft[p.id] = "";
  });
}

function route(job: string) {
  if (!settings.value) return { provider: "", model: "" };
  const r = (settings.value.routing[job] ??= { provider: settings.value.providers[0]?.id ?? "", model: "" });
  return r;
}
const providerOf = (id: string) => settings.value?.providers.find((p) => p.id === id);
</script>

<template>
  <div class="settings">
    <header>
      <h1>Settings</h1>
      <button class="ghost" @click="emit('close')">Back to reading</button>
    </header>

    <p v-if="error" class="err">{{ error }}</p>

    <section>
      <div class="row">
        <h2>Models and providers</h2>
        <button class="ghost" :disabled="!!busy" @click="rescan">Rescan for installed agents</button>
      </div>
      <p class="note">Agent CLIs use your own subscription. Endpoints are any OpenAI-compatible server. Keys are kept in the system keychain.</p>

      <p v-if="settings && missing('codex')" class="note">Codex CLI isn't installed or wasn't found. Install it and rescan, or add its path below.</p>
      <div v-if="!settings?.providers.length" class="empty">No providers yet. Install Claude Code or Hermes and rescan, or add an endpoint below.</div>

      <div v-for="p in settings?.providers" :key="p.id" class="card">
        <div class="head">
          <div>
            <strong>{{ p.name }}</strong>
            <span class="tag">{{ p.kind === "agent" ? "agent CLI" : "endpoint" }}</span>
          </div>
          <div class="actions">
            <button :disabled="tests[p.id] === 'running'" @click="test(p, p.model ?? undefined)">{{ tests[p.id] === "running" ? "Testing…" : "Test connection" }}</button>
            <button v-if="p.kind === 'endpoint' || p.manual" class="ghost danger" @click="removeProvider(p)">Remove</button>
          </div>
        </div>
        <div class="meta">{{ p.kind === "agent" ? p.path : p.baseUrl }}</div>
        <div class="field">
          <span>Default model</span>
          <ModelSelect v-model="p.model" :options="optionsFor(p)" :loading="fetching[p.id]" :default-label="p.kind === 'agent' ? 'CLI default' : 'Choose a model'" @change="persist" />
          <button v-if="p.kind === 'endpoint'" class="ghost" :disabled="fetching[p.id]" @click="loadModels(p)">List models</button>
        </div>
        <p v-if="modelErr[p.id]" class="mini err">{{ modelErr[p.id] }}</p>
        <div v-if="p.kind === 'endpoint'" class="field keyrow">
          <span>API key</span>
          <template v-if="hasKey[p.id]"><em>saved in keychain</em><button class="ghost" @click="api.secretDelete(p.id).then(() => (hasKey[p.id] = false))">Clear</button></template>
          <template v-else>
            <input v-model="keyDraft[p.id]" type="password" placeholder="optional for local servers" autocomplete="off" />
            <button @click="saveKey(p)">Save key</button>
          </template>
        </div>
        <div v-if="tests[p.id] && tests[p.id] !== 'running'" class="result" :class="(tests[p.id] as TestResult).ok ? 'ok' : 'bad'">
          <template v-if="(tests[p.id] as TestResult).ok">Works · {{ (tests[p.id] as TestResult).ms }} ms · {{ (tests[p.id] as TestResult).model || "model not reported" }}</template>
          <template v-else>{{ (tests[p.id] as TestResult).error }}</template>
        </div>
      </div>
    </section>

    <section v-if="settings?.providers.length">
      <h2>Which model does what</h2>
      <p class="note">Structured extraction does fine on a cheaper model. Choose per job.</p>
      <div v-for="j in JOBS" :key="j.id" class="route">
        <div class="jobname">
          <strong>{{ j.label }}</strong>
          <span>{{ j.hint }}</span>
        </div>
        <select v-model="route(j.id).provider" @change="persist">
          <option v-for="p in settings.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <ModelSelect v-model="route(j.id).model" :options="optionsFor(providerOf(route(j.id).provider))" default-label="Provider default" @change="persist" />
      </div>
    </section>

    <section>
      <h2>Picture judge</h2>
      <p class="note">While you read, a small model looks at the picture now and then and checks it suits the text. It widens shots that are too tight and drops effects that keep failing. It uses the "Picture judge" model above and stops at the limit you set for each book.</p>
      <div class="sound">
        <label class="field"><span>Check pictures while reading</span>
          <select :value="judgeSettings.on ? 'on' : 'off'" @change="(e) => { judgeSettings.on = (e.target as HTMLSelectElement).value === 'on'; saveJudgeSettings(); }">
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label class="field"><span>Most to spend per book (US$)</span>
          <input type="number" min="0.05" step="0.05" :value="judgeSettings.cap" @change="(e) => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) { judgeSettings.cap = v; saveJudgeSettings(); } }" />
        </label>
      </div>
    </section>

    <section>
      <h2>Look</h2>
      <p class="note">How the picture is drawn. By default each book gets the look that suits its text (or the one its package recommends). Pick one here to use it for every book. A look you choose for a single book or chapter, in Details, still wins.</p>
      <div class="sound">
        <label class="field"><span>Default look</span>
          <select :value="defaultStyle ?? 'auto'" @change="(e) => { const v = (e.target as HTMLSelectElement).value; setDefaultStyle(isStyle(v) ? v : null); }">
            <option value="auto">Automatic: each book picks its own</option>
            <option v-for="st in STYLES" :key="st.id" :value="st.id">{{ st.label }}: {{ st.blurb }}</option>
          </select>
        </label>
      </div>
    </section>

    <section>
      <h2>Sound</h2>
      <p class="note">Ambient beds and effects are synthesised on your machine from each scene's mood, weather and cues. Nothing is downloaded. Off by default.</p>
      <div class="sound">
        <label class="field"><span>Sound</span>
          <button :class="soundOn ? '' : 'ghost'" @click="setSound(!soundOn)">{{ soundOn ? "On" : "Off" }}</button>
        </label>
        <label class="field"><span>Volume</span>
          <input type="range" min="0" max="1" step="0.01" :value="soundVolume" @input="setVolume(Number(($event.target as HTMLInputElement).value))" />
          <em class="lvl">{{ Math.round(soundVolume * 100) }}%</em>
        </label>
        <div class="field"><span>Try</span>
          <div class="actions">
            <button class="ghost" :disabled="!soundOn" @click="engine.test('metal')">Clink</button>
            <button class="ghost" :disabled="!soundOn" @click="engine.test('impact')">Impact</button>
            <button class="ghost" :disabled="!soundOn" @click="engine.test('whoosh')">Whoosh</button>
            <button class="ghost" :disabled="!soundOn" @click="engine.test('thunder')">Thunder</button>
            <button class="ghost" :disabled="!soundOn" @click="engine.test('patter')">Hail</button>
          </div>
        </div>
        <div v-if="soundOn" class="meter"><div :style="{ width: Math.min(100, soundLevel * 400) + '%' }" /></div>
      </div>
    </section>

    <section v-if="stats">
      <h2>Storage</h2>
      <p class="note">Everything here is a cache and can be rebuilt. Prepared scenes over 3 GB are trimmed oldest-first, and ones from older versions of the scene engine are removed automatically.</p>
      <div class="storage">
        <div><strong>Prepared scenes</strong><span>{{ stats.renderScenes }} scenes · {{ mb(stats.renderBytes) }}</span><button class="ghost" :disabled="!!busy" @click="clearCache('renders')">Clear</button></div>
        <div><strong>Downloaded assets</strong><span>{{ mb(stats.assetsBytes) }} (CC0 models, skies, textures)</span><button class="ghost" :disabled="!!busy" @click="clearCache('assets')">Clear</button></div>
        <div><strong>Analysis</strong><span>{{ mb(stats.analysisBytes) }} (model replies)</span><button class="ghost" :disabled="!!busy" @click="clearCache('analysis')">Clear</button></div>
      </div>
    </section>

    <section>
      <h2>Add an agent CLI by path</h2>
      <p class="note">If a CLI is installed somewhere the scan can't see. Claude Code, Hermes and Codex are supported.</p>
      <div class="form">
        <label class="field"><span>CLI</span>
          <select v-model="agentDraft.cli"><option v-for="(n, k) in agentNames" :key="k" :value="k">{{ n }}</option></select>
        </label>
        <label class="field"><span>Path</span><input v-model="agentDraft.path" placeholder="/opt/homebrew/bin/codex" /></label>
        <button :disabled="!agentDraft.path.trim() || !!busy" @click="addAgent">Add agent</button>
      </div>
    </section>

    <section>
      <h2>Add an endpoint</h2>
      <p class="note">For a local or hosted OpenAI-compatible server.</p>
      <div class="form">
        <label class="field"><span>Preset</span>
          <select v-model.number="draft.preset" @change="pickPreset"><option v-for="(p, i) in presets" :key="p.name" :value="i">{{ p.name }}</option></select>
        </label>
        <label class="field"><span>Name</span><input v-model="draft.name" placeholder="shown in the app" /></label>
        <label class="field"><span>Base URL</span><input v-model="draft.baseUrl" placeholder="http://localhost:11434/v1" /></label>
        <div class="field"><span>Model</span>
          <ModelSelect v-model="draft.model" :options="draftModels.map((m) => ({ value: m }))" :loading="draftLoading" default-label="Choose a model" />
          <button class="ghost" :disabled="!draft.baseUrl || draftLoading" @click="loadDraftModels">List models</button>
        </div>
        <p v-if="draftErr" class="mini err">{{ draftErr }}</p>
        <label class="field"><span>API key</span><input v-model="draft.key" type="password" placeholder="optional" autocomplete="off" /></label>
        <button :disabled="!draft.baseUrl || !draft.model || !!busy" @click="addEndpoint">Add endpoint</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings { background: var(--bg); position: relative; z-index: 1; height: 100vh; overflow-y: auto; padding: 28px clamp(20px, 5vw, 64px) 64px; box-sizing: border-box; color: var(--ink); }
header { display: flex; justify-content: space-between; align-items: center; max-width: 760px; margin: 0 auto 8px; }
h1 { font: 600 22px/1.2 system-ui, sans-serif; margin: 0; }
h2 { font: 600 15px/1.3 system-ui, sans-serif; margin: 0; }
section { max-width: 760px; margin: 28px auto 0; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.note { color: #8b8f99; font: 13px/1.5 system-ui, sans-serif; margin: 6px 0 14px; }
.empty { padding: 18px; border: 1px dashed #2b2f38; border-radius: 10px; color: #8b8f99; font: 13px system-ui, sans-serif; }
.card { border: 1px solid #23262d; background: #14171c; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; font: 13px/1.4 system-ui, sans-serif; }
.head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.tag { margin-left: 8px; font-size: 11px; color: #8b8f99; border: 1px solid #2b2f38; border-radius: 99px; padding: 1px 8px; }
.meta { color: #6d7280; font: 12px ui-monospace, Menlo, monospace; margin: 4px 0 10px; word-break: break-all; }
.actions { display: flex; gap: 8px; }
.field { display: grid; grid-template-columns: 110px 1fr auto; align-items: center; gap: 10px; margin-top: 8px; color: #aab; }
.field > span { color: #8b8f99; }
.keyrow em { color: #7fc98f; font-style: normal; grid-column: 2; }
.result { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font: 12px/1.4 ui-monospace, Menlo, monospace; word-break: break-word; }
.result.ok { background: #14261a; color: #8fd4a0; }
.result.bad { background: #2a1717; color: #e59a9a; }
.err { max-width: 760px; margin: 12px auto; padding: 10px 12px; background: #2a1717; color: #e59a9a; border-radius: 8px; font: 13px system-ui, sans-serif; }
.route { display: grid; grid-template-columns: 1.1fr 1fr 1fr; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid #1c1f26; }
.jobname { display: flex; flex-direction: column; font: 13px system-ui, sans-serif; }
.jobname span { color: #6d7280; font-size: 12px; }
.form { display: grid; gap: 2px; }
.sound { display: grid; gap: 2px; }
.mini { margin: 6px 0 0; font: 12px system-ui, sans-serif; }
.mini.err { color: #e59a9a; }
.storage { display: grid; gap: 8px; }
.storage > div { display: grid; grid-template-columns: 150px 1fr auto; gap: 10px; align-items: center; font: 13px system-ui, sans-serif; padding: 8px 0; border-bottom: 1px solid #1c1f26; }
.storage span { color: #8b8f99; }
.lvl { color: #8b8f99; font-style: normal; font: 12px ui-monospace, Menlo, monospace; }
.meter { height: 4px; background: #1c1f26; border-radius: 2px; overflow: hidden; margin-top: 12px; }
.meter > div { height: 100%; background: #7fc98f; transition: width 0.2s; }
.form button { justify-self: start; margin-top: 12px; }
input, select { background: #0f1115; color: var(--ink); border: 1px solid #2b2f38; border-radius: 8px; padding: 7px 10px; font: 13px system-ui, sans-serif; min-width: 0; }
input:focus, select:focus { outline: 1px solid #c9a54a; border-color: #c9a54a; }
button { background: #c9a54a; color: #15120a; border: 0; border-radius: 8px; padding: 7px 12px; font: 600 12.5px system-ui, sans-serif; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.ghost { background: transparent; color: #aab; border: 1px solid #2b2f38; }
button.danger { color: #e59a9a; }
</style>
