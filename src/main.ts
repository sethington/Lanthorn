import { createApp } from "vue";
import App from "./App.vue";

const app = createApp(App);
// a render or lifecycle error is shown in the dev log (it would otherwise go to a console nobody is reading)
if (import.meta.env.DEV) {
  const say = (kind: string, msg: unknown, info?: string) => fetch("/__debug", { method: "POST", body: JSON.stringify({ kind, data: { msg: String((msg as Error)?.stack ?? msg).slice(0, 1200), info } }) }).catch(() => {});
  app.config.errorHandler = (err, _vm, info) => say("vue-error", err, info);
  app.config.warnHandler = (m) => say("vue-warn", m);
}
app.mount("#app");
