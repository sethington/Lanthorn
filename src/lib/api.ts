import { recordUsage, type Usage } from "./usage";
import { invoke } from "@tauri-apps/api/core";
import type { BookMeta } from "./book";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type Provider = {
  id: string;
  name: string;
  kind: "agent" | "endpoint";
  cli?: string | null;
  path?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  manual?: boolean;
};
export type Route = { provider: string; model?: string | null };
export type Settings = { providers: Provider[]; routing: Record<string, Route>; initialized: boolean };
export type TestResult = { ok: boolean; ms: number; sample: string; model: string; error?: string | null };
export type Completion = { text: string; providerId: string; model: string; ms: number; usage?: Usage };


export type CacheStats = { renderBytes: number; renderScenes: number; assetsBytes: number; analysisBytes: number };
export type Pruned = { removed: number; freedBytes: number };

export type PackageManifest = {
  format: string; version: number; id: string; title: string; author?: string; language?: string; license?: string; creator?: string; description?: string; style?: string;
  chapters: { id: string; num?: string; title: string; text: string; scenes?: string; style?: string }[];
  assets: { id: string; kind: string; path: string; tags: string[]; height?: number; license: string; author?: string; source?: string }[];
};
export type InstalledPackage = { manifest: PackageManifest; chapters: { id: string; text: string; scenes?: string | null }[]; assetsInstalled: number };
export type Page = { finalUrl: string; contentType: string; html: string };

export const JOBS = [
  { id: "scan", label: "Book scan", hint: "genre, tone, style profile" },
  { id: "bible", label: "Story bible", hint: "characters, places" },
  { id: "scene", label: "Scenes", hint: "text to scene JSON" },
  { id: "judge", label: "Picture judge", hint: "checks the world matches the text (small model)" },
] as const;

function need<T>(f: () => Promise<T>): Promise<T> {
  if (!inTauri) return Promise.reject(new Error("LLM features run inside the Lanthorn app, not a plain browser"));
  return f();
}

export const api = {
  settingsLoad: () => need(() => invoke<Settings>("settings_load")),
  settingsSave: (settings: Settings) => need(() => invoke<void>("settings_save", { settings })),
  agentsDetect: () => need(() => invoke<Settings>("agents_detect")),
  secretSet: (id: string, value: string) => need(() => invoke<void>("secret_set", { id, value })),
  secretExists: (id: string) => need(() => invoke<boolean>("secret_exists", { id })),
  secretDelete: (id: string) => need(() => invoke<void>("secret_delete", { id })),
  llmTest: (providerId: string, model?: string) => need(() => invoke<TestResult>("llm_test", { providerId, model: model || null })),
  cacheGet: (ns: string, key: string) => need(() => invoke<string | null>("cache_get", { ns, key })),
  cachePut: (ns: string, key: string, value: string) => need(() => invoke<void>("cache_put", { ns, key, value })),
  cacheStats: () => need(() => invoke<CacheStats>("cache_stats")),
  cachePrune: (version: string, maxBytes: number) => need(() => invoke<Pruned>("cache_prune", { version, maxBytes })),
  cacheClear: (kind: "renders" | "assets" | "analysis") => need(() => invoke<number>("cache_clear", { kind })),
  // the package's bytes go as the raw request body, not JSON
  packageInstall: (bytes: Uint8Array) => need(() => invoke<InstalledPackage>("package_install", bytes)),
  packageRemove: (id: string) => need(() => invoke<void>("package_remove", { id })),
  sceneWorld: (key: string, resolved: string, assets: { kind: string; id: string; res: string }[]) => need(() => invoke<{ bundle: string; dir: string }>("scene_world", { key, resolved, assets })),
  worldAvailable: () => need(() => invoke<boolean>("world_available")),
  worldOpen: (x: number, y: number, w: number, h: number, pw?: number, ph?: number) => need(() => invoke<{ scale: number }>("world_open", { x, y, w, h, pw, ph })),
  worldCmd: (body: Record<string, unknown>) => need(() => invoke<unknown>("world_cmd", { body })),
  libraryList: () => need(() => invoke<BookMeta[]>("library_list")),
  libraryGet: (id: string) => need(() => invoke<string | null>("library_get", { id })),
  librarySave: (id: string, json: string) => need(() => invoke<BookMeta>("library_save", { id, json })),
  libraryDelete: (id: string) => need(() => invoke<void>("library_delete", { id })),
  fetchPage: (url: string) => need(() => invoke<Page>("fetch_page", { url })),
  renderAvailable: () => need(() => invoke<boolean>("render_available")),
  endpointModels: (providerId?: string, baseUrl?: string, key?: string) => need(() => invoke<string[]>("endpoint_models", { providerId: providerId ?? null, baseUrl: baseUrl ?? null, key: key ?? null })),
  cacheDir: () => need(() => invoke<string>("cache_dir")),
  llmVision: (job: string, system: string, user: string, image: string) => need(() => invoke<Completion>("llm_vision", { job, system, user, image })).then((c) => { recordUsage(job, c.usage); return c; }),
  llmComplete: (job: string, system: string, user: string) => need(() => invoke<Completion>("llm_complete", { job, system, user })).then((c) => { recordUsage(job, c.usage); return c; }),
};
