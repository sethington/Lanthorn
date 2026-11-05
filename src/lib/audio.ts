// Sound engine: procedural ambient beds and spot effects (Web Audio), driven by reading position.
// No downloads, no licences: everything is synthesised from the scene's audio/mood/weather fields.
// Generated or sampled sound can replace recipes later behind the same interface (docs/spec.md).

import { ref } from "vue";
import type { Scene } from "./scene";

const KEY_ON = "lanthorn:sound:on";
const KEY_VOL = "lanthorn:sound:vol";
const read = (k: string, d: string) => {
  try { return localStorage.getItem(k) ?? d; } catch { return d; }
};
const write = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* optional */ }
};

export const soundOn = ref(read(KEY_ON, "0") === "1");
export const soundVolume = ref(Math.min(1, Math.max(0, Number(read(KEY_VOL, "0.6")) || 0.6)));
export const soundLevel = ref(0); // RMS of what's coming out, 0..1 (for the UI and for checking it's alive)

type Bed = { out: GainNode; update: (progress: number) => void; stop: () => void };
type Src = AudioScheduledSourceNode;

const has = (txt: string, re: RegExp) => re.test(txt);

class Engine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  analyser!: AnalyserNode;
  reverb!: ConvolverNode;
  noise: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer } | null = null;
  bed: { key: string; bed: Bed } | null = null;
  lastSid = -1;
  lastSpotAt = 0;
  last: { scene: Scene | null; sid: number; progress: number } | null = null;
  unresolved = new Set<string>();
  private meterTimer = 0;

  async enable() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.master.connect(comp).connect(this.analyser).connect(ctx.destination);
      this.noise = { white: this.makeNoise("white"), pink: this.makeNoise("pink"), brown: this.makeNoise("brown") };
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this.makeImpulse(2.6);
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      this.reverb.connect(wet).connect(this.master);
      this.startMeter();
    }
    this.setVolume(soundVolume.value);
    await this.ctx.resume();
    // start the bed for wherever the reader already is
    if (this.last) this.onPosition(this.last.scene, this.last.sid, this.last.progress);
  }

  async disable() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    const ctx = this.ctx;
    window.setTimeout(() => { if (!soundOn.value) ctx.suspend(); }, 600);
  }

  setVolume(v: number) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.08); // squared: closer to perceived loudness
  }

  private startMeter() {
    const buf = new Float32Array(this.analyser.fftSize);
    this.meterTimer = window.setInterval(() => {
      if (!this.ctx || this.ctx.state !== "running") { soundLevel.value = 0; return; }
      this.analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      soundLevel.value = Math.sqrt(s / buf.length);
    }, 250);
  }

  // ---- buffers
  private makeNoise(kind: "white" | "pink" | "brown"): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 6;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === "white") d[i] = w * 0.5;
      else if (kind === "pink") {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    // equal-power crossfade of the ends so the loop has no seam
    const fade = Math.floor(ctx.sampleRate * 0.25);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
    return buf;
  }

  private makeImpulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    return buf;
  }

  // ---- node helpers
  private loop(kind: "white" | "pink" | "brown", dest: AudioNode, gain: number, chain: AudioNode[] = [], nodes: Src[] = []): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise![kind];
    src.loop = true;
    src.loopStart = 0.3;
    src.loopEnd = 5.7;
    let prev: AudioNode = src;
    for (const n of chain) { prev.connect(n); prev = n; }
    const g = ctx.createGain();
    g.gain.value = gain;
    prev.connect(g).connect(dest);
    src.start(0, Math.random() * 4);
    nodes.push(src);
    return g;
  }

  private lfo(rate: number, depth: number, target: AudioParam, nodes: Src[]) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start();
    nodes.push(o);
    return o;
  }

  private filter(type: BiquadFilterType, f: number, q = 0.7) {
    const b = this.ctx!.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  // ---- beds
  private buildBed(scene: Scene): Bed {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    const nodes: Src[] = [];
    const updaters: ((p: number) => void)[] = [];
    const txt = [scene.audio.bed, scene.location, scene.weather, scene.mood, scene.kind, scene.props.join(" ")].join(" ").toLowerCase();
    const night = scene.time.start === "night" || scene.time.end === "night";
    const storm = scene.weather === "storm";
    const rain = scene.weather === "rain" || storm || has(txt, /hail|rain/);
    const outdoors = !scene.interior || has(txt, /hill|garden|landscape|open air|field|lawn/);

    // base air / room tone
    if (outdoors) {
      this.loop("pink", out, 0.05, [this.filter("lowpass", 1400)], nodes);
    } else {
      this.loop("brown", out, 0.12, [this.filter("lowpass", 380)], nodes);
      const hum = ctx.createOscillator();
      hum.frequency.value = 55;
      const hg = ctx.createGain();
      hg.gain.value = 0.018;
      hum.connect(hg).connect(out);
      hum.start();
      nodes.push(hum);
    }

    // wind: band-passed pink noise with slow swells
    if (outdoors && (has(txt, /wind|hill|open|storm|dawn|dusk|landscape|garden|fog|vertig/) || storm)) {
      const bp = this.filter("bandpass", 420, 0.9);
      const g = this.loop("pink", out, storm ? 0.2 : 0.09, [bp], nodes);
      this.lfo(0.13, storm ? 0.12 : 0.05, g.gain, nodes);
      this.lfo(0.09, 180, bp.frequency, nodes);
    }

    // rain / hail: bright noise, plus rumble in a storm
    if (rain) {
      this.loop("white", out, storm ? 0.1 : 0.06, [this.filter("highpass", 1800), this.filter("lowpass", 9000)], nodes);
      if (storm) {
        const g = this.loop("brown", out, 0.18, [this.filter("lowpass", 140)], nodes);
        this.lfo(0.07, 0.1, g.gain, nodes);
      }
    }

    // night insects (not in rain)
    if (night && outdoors && !rain) {
      const c = ctx.createOscillator();
      c.frequency.value = 4300;
      const am = ctx.createGain();
      am.gain.value = 0;
      const cg = ctx.createGain();
      cg.gain.value = 0.012;
      c.connect(am).connect(cg).connect(out);
      this.lfo(38, 0.5, am.gain, nodes);
      this.lfo(2.6, 0.5, am.gain, nodes);
      c.start();
      nodes.push(c);
    }

    // the machine: a low thrum whose tremolo quickens with the scene
    let thrum: GainNode | null = null;
    let thrumLfo: OscillatorNode | null = null;
    if (has(txt, /machine|lever|dial|quartz|thrum|mechanic|clock/)) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = 68;
      thrum = ctx.createGain();
      thrum.gain.value = 0.05;
      o.connect(thrum).connect(out);
      o.start();
      nodes.push(o);
      thrumLfo = this.lfo(2, 0.03, thrum.gain, nodes);
    }

    // time-lapse: a sweeping rush with day/night flicker that speeds up
    let sweepBp: BiquadFilterNode | null = null;
    let sweepGain: GainNode | null = null;
    let flicker: OscillatorNode | null = null;
    if (scene.kind === "timelapse" || has(txt, /time.?lapse|rush|accelerat|whir/)) {
      sweepBp = this.filter("bandpass", 300, 1.4);
      sweepGain = this.loop("pink", out, 0.0, [sweepBp], nodes);
      flicker = this.lfo(1.2, 0.05, sweepGain.gain, nodes);
    }

    // a slow pad from the mood
    const chords: [RegExp, number[]][] = [
      [/dread|tense|ominous|naus|vertig|disorient|storm|panic|chaos|violent|surreal|confus/, [110, 164.8, 196, 233.1]],
      [/awe|wonder|exhilar|beaut|serene|marvel|flux/, [146.8, 220, 329.6, 370]],
      [/calm|reflect|anticip|quiet|peace|content/, [130.8, 196, 293.7, 329.6]],
    ];
    const chord = chords.find(([re]) => re.test(txt))?.[1] ?? [110, 164.8, 247];
    const padOut = ctx.createGain();
    padOut.gain.value = 0.05;
    const padLp = this.filter("lowpass", 800);
    padLp.connect(padOut);
    padOut.connect(out);
    padOut.connect(this.reverb);
    chord.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? "triangle" : "sine";
      o.frequency.value = f;
      o.detune.value = (i - 1.5) * 6;
      const g = ctx.createGain();
      g.gain.value = 0.28;
      o.connect(g).connect(padLp);
      this.lfo(0.05 + i * 0.017, 0.12, g.gain, nodes);
      o.start();
      nodes.push(o);
    });

    return {
      out,
      update: (p: number) => {
        const t = ctx.currentTime;
        if (thrumLfo) thrumLfo.frequency.setTargetAtTime(2 + 16 * p * p, t, 0.2);
        if (thrum) thrum.gain.setTargetAtTime(0.04 + 0.08 * p, t, 0.3);
        if (sweepBp) sweepBp.frequency.setTargetAtTime(250 + 2600 * p * p, t, 0.15);
        if (sweepGain) sweepGain.gain.setTargetAtTime(0.02 + 0.16 * p, t, 0.2);
        if (flicker) flicker.frequency.setTargetAtTime(1 + 13 * p * p, t, 0.2);
        for (const u of updaters) u(p);
      },
      stop: () => {
        for (const n of nodes) { try { n.stop(); } catch { /* already stopped */ } }
        out.disconnect();
        padOut.disconnect();
      },
    };
  }

  // ---- spots
  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private burst(t: number, dur: number, peak: number, f: number, type: BiquadFilterType = "lowpass", q = 0.7) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!.white;
    const fl = this.filter(type, f, q);
    const g = ctx.createGain();
    src.connect(fl).connect(g).connect(this.master);
    this.env(g, t, peak, 0.004, dur);
    src.start(t, Math.random() * 3);
    src.stop(t + dur + 0.1);
  }

  private tone(t: number, f0: number, f1: number, dur: number, peak: number, type: OscillatorType = "sine", sendReverb = false) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    o.connect(g).connect(this.master);
    if (sendReverb) g.connect(this.reverb);
    this.env(g, t, peak, 0.004, dur);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  private spot(kind: string) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.02;
    switch (kind) {
      case "metal": [2100, 3400, 5600].forEach((f, i) => this.tone(t, f, f * 0.98, 0.45 / (1 + i * 0.6), 0.1 / (1 + i), "sine", true)); this.burst(t, 0.03, 0.15, 6000, "highpass"); break;
      case "impact": this.tone(t, 130, 38, 0.6, 0.55); this.burst(t, 0.5, 0.35, 700); break;
      case "thunder": this.burst(t, 2.4, 0.5, 220); this.tone(t, 70, 30, 2.2, 0.3); break;
      case "whoosh": { const src = ctx.createBufferSource(); src.buffer = this.noise!.pink; const bp = this.filter("bandpass", 300, 1.2); bp.frequency.exponentialRampToValueAtTime(3200, t + 0.9); const g = ctx.createGain(); src.connect(bp).connect(g).connect(this.master); this.env(g, t, 0.5, 0.35, 0.6); src.start(t, 1); src.stop(t + 1.2); break; }
      case "patter": for (let i = 0; i < 9; i++) this.burst(t + i * 0.13 + Math.random() * 0.05, 0.05, 0.12, 4200, "bandpass", 1.5); break;
      case "steps": for (let i = 0; i < 4; i++) this.burst(t + i * 0.42, 0.12, 0.25, 420); break;
      case "tick": for (let i = 0; i < 5; i++) this.tone(t + i * 0.5, 1800, 1500, 0.04, 0.12); break;
      case "creak": { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(170, t); o.frequency.linearRampToValueAtTime(250, t + 0.9); const bp = this.filter("bandpass", 700, 6); const g = ctx.createGain(); o.connect(bp).connect(g).connect(this.master); this.env(g, t, 0.12, 0.2, 0.7); o.start(t); o.stop(t + 1); break; }
      case "chime": [523, 784, 1318].forEach((f, i) => this.tone(t + i * 0.02, f, f, 1.6, 0.12 / (1 + i * 0.5), "sine", true)); break;
      default: break;
    }
  }

  private classifySpot(text: string): string | null {
    const s = text.toLowerCase();
    if (has(s, /thunder|rumble/)) return "thunder";
    if (has(s, /overturn|crash|slam|thud|impact|hit|bang|tumbl|fall|thrown|smash/)) return "impact";
    if (has(s, /clink|clank|tool|metal|ting|rail|lever|latch|click|brass/)) return "metal";
    if (has(s, /whoosh|rush|swoosh|speed|zoom|sweep|blur|whir/)) return "whoosh";
    if (has(s, /hail|rain|patter|drip|splash/)) return "patter";
    if (has(s, /step|walk|foot|crunch|boot/)) return "steps";
    if (has(s, /clock|tick|tock/)) return "tick";
    if (has(s, /door|creak|hinge/)) return "creak";
    if (has(s, /bell|chime|ring/)) return "chime";
    return null;
  }

  // ---- driven by the reader
  /** Called whenever the reading line moves. scene = the scene the line is in (null if none). */
  onPosition(scene: Scene | null, sid: number, progress: number) {
    this.last = { scene, sid, progress };
    if (!this.ctx || !soundOn.value || this.ctx.state !== "running") { this.lastSid = sid; return; }
    const ctx = this.ctx;

    // bed: crossfade on a scene change; non-visual scenes keep the current bed
    if (scene && scene.visual) {
      const key = `${scene.id}:${scene.from}`;
      if (!this.bed || this.bed.key !== key) {
        const next = this.buildBed(scene);
        const t = ctx.currentTime;
        next.out.gain.setTargetAtTime(1, t, 0.6);
        const old = this.bed;
        if (old) {
          old.bed.out.gain.setTargetAtTime(0, t, 0.6);
          window.setTimeout(() => old.bed.stop(), 3500);
        }
        this.bed = { key, bed: next };
      }
      this.bed.bed.update(progress);
    }

    // spots: only when the line moves forward across a cue, and not on a long jump
    const moved = sid - this.lastSid;
    if (scene && this.lastSid >= 0 && moved > 0 && moved <= 3) {
      for (const sp of scene.audio.spots) {
        if (sp.at > this.lastSid && sp.at <= sid && ctx.currentTime - this.lastSpotAt > 0.35) {
          const kind = this.classifySpot(sp.sound);
          if (kind) { this.spot(kind); this.lastSpotAt = ctx.currentTime; }
          else if (!this.unresolved.has(sp.sound)) this.unresolved.add(sp.sound);
        }
      }
    }
    this.lastSid = sid;
  }

  /** Play a named spot now (for testing from the UI). */
  test(kind: string) {
    if (this.ctx?.state === "running") this.spot(kind);
  }

  dispose() {
    window.clearInterval(this.meterTimer);
    this.bed?.bed.stop();
    this.ctx?.close();
    this.ctx = null;
    this.bed = null;
  }
}

export const engine = new Engine();

export async function setSound(on: boolean) {
  soundOn.value = on;
  write(KEY_ON, on ? "1" : "0");
  if (on) await engine.enable();
  else await engine.disable();
}

export function setVolume(v: number) {
  soundVolume.value = v;
  write(KEY_VOL, String(v));
  engine.setVolume(v);
}
