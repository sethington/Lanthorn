import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame, useGameState, type FrameInput } from "raea";
import { Bloom, DepthOfField, Entity, Environment, Fog, Grade, Look, Model, Outline, Shadows, Sphere, ToneMapping, Torus } from "raea/3d";
import { LinearRgba, Srgba } from "raea/color";
import { Affine2 } from "raea/math";
import { StandardMaterial } from "raea/pbr";
import { Capsule3d, Cone, Cuboid, Cylinder, Mesh3d, Plane3d } from "raea/mesh";
import { AmbientLight, DirectionalLight, PointLight } from "raea/light";
import { Quat, Transform } from "raea/transform";
import { Camera3d } from "raea/camera";
import data from "./scene.json" with { type: "json" };

// Generic runtime: renders any resolved Lanthorn scene (see src/lib/resolve.ts). Pure function of the frame.
const R: any = data;
const N: number = R.frames;
const [W, H]: [number, number] = R.size;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const glow = (hex: string, k: number) => LinearRgba.from(Srgba.hex(hex)).mul(k);
const media = (p: string) => staticFile(p);
const tex = (id: string, f: string) => media(`polyhaven/${id}/${f}`);
const D2R = Math.PI / 180;

// ---- live mode: the scene as an interactive world (R.live). Drag or arrow keys orbit, W/S zoom, A/D slide left and right, space pauses.
// The same file still bakes frames when R.live is false: the hooks run either way but only live mode reads them.
const LOOK: number[] = R.camera.lookFrom;
const C0 = R.camera.from;
const D0 = Math.hypot(C0[0] - LOOK[0], C0[1] - LOOK[1], C0[2] - LOOK[2]);
const WORLD0 = {
  t: (R.t0 as number) ?? 0, // narrative position 0..1: time of day, beats, figure walks
  yaw: Math.atan2(C0[0] - LOOK[0], C0[2] - LOOK[2]),
  pitch: Math.asin(clamp((C0[1] - LOOK[1]) / D0, -1, 1)),
  dist: D0,
  // the shot camera as shown: it glides toward the wanted shot (a cut becomes a move, never a fade)
  sm: { cam: [...R.camera.from] as number[], look: [...R.camera.lookFrom] as number[], fov: R.camera.fov as number, init: false },
  pan: 0, // sideways shift of the orbit's centre, metres (A/D)
  px: 0, py: 0, drag: false, paused: false, spaceHeld: false,
  // set by the host each frame (Lanthorn's director): which shot, how far through it, how dark the screen is, and whether
  // the viewer has taken the controls (then the camera orbits instead of following the shot)
  shot: -1, shotP: -1, fade: 0, control: false,
};
type World = typeof WORLD0;
const LOOP_SECONDS = (R.loopSeconds as number) ?? 40;

function stepWorld(s: World, input: FrameInput, _frame: number): World {
  const has = (k: string) => input.keys.includes(k);
  let { yaw, pitch, dist, t, paused, px, py, drag, pan } = s;
  const control = has("Control:1") || drag;
  if (has("ArrowLeft")) yaw -= 0.05;
  if (has("ArrowRight")) yaw += 0.05;
  if (has("a")) pan -= 0.02 * dist; // A/D slide the view left and right
  if (has("d")) pan += 0.02 * dist;
  if (has("ArrowUp")) pitch += 0.025;
  if (has("ArrowDown")) pitch -= 0.025;
  if (has("w")) dist *= 0.955;
  if (has("s")) dist *= 1.045;
  // taking the controls mid-shot: carry on from the shot's camera, not from the scene's default view
  if (control && !s.control && s.shot >= 0 && (R.shots as any[])?.[s.shot]) {
    const sh = (R.shots as any[])[s.shot];
    const k = smooth(0, 1, Math.max(0, s.shotP));
    const cam = [0, 1, 2].map((i) => mix(sh.from[i], sh.to[i], k));
    const look = [0, 1, 2].map((i) => mix(sh.lookFrom[i], sh.lookTo[i], k));
    const v = [cam[0] - look[0], cam[1] - LOOK[1], cam[2] - look[2]];
    dist = Math.max(0.5, Math.hypot(v[0], v[1], v[2]));
    yaw = Math.atan2(v[0], v[2]);
    pitch = Math.asin(clamp(v[1] / dist, -1, 1));
    // the orbit's centre is LOOK slid sideways by `pan` along the camera's right: put it under the shot's look point
    pan = (look[0] - LOOK[0]) * Math.cos(yaw) - (look[2] - LOOK[2]) * Math.sin(yaw);
  }
  // pointer may arrive normalised (0..1) or in pixels: accept both
  const ptr = (input as any).pointer as { x: number; y: number; down: boolean } | undefined;
  if (ptr) {
    const nx = ptr.x > 2 ? ptr.x / W : ptr.x;
    const ny = ptr.y > 2 ? ptr.y / H : ptr.y;
    if (ptr.down && drag) {
      yaw -= (nx - px) * 3;
      pitch += (ny - py) * 2;
    }
    drag = ptr.down;
    px = nx;
    py = ny;
  } else drag = false;
  const num = (prefix: string, d: number) => { const k = input.keys.find((x) => x.startsWith(prefix)); return k ? parseFloat(k.slice(prefix.length)) : d; };
  const shot = num("Shot:", -1);
  widenS += (num("Widen:", 0) - widenS) * 0.06; // the picture judge asks for a wider view when a shot is too tight
  const shotP = num("ShotP:", -1);
  const fade = clamp(num("Fade:", 0));
  const space = has(" ");
  if (space && !s.spaceHeld) paused = !paused;
  // the host (Lanthorn's reader) can set the narrative position through a key "Narrative:<0..1>"; otherwise time runs itself
  const nk = input.keys.find((k) => k.startsWith("Narrative:"));
  if (nk) t = clamp(parseFloat(nk.slice(10)) || 0);
  else if (!paused) t = (t + 1 / (R.fps * LOOP_SECONDS)) % 1;
  // the wanted shot camera, and the shown one easing toward it
  const shotList = (R.shots ?? []) as any[];
  const sIdx = shot >= 0 && shotList.length ? Math.min(shot, shotList.length - 1) : -1;
  const cc = sIdx >= 0 ? shotList[sIdx] : R.camera;
  const kk = smooth(0, 1, sIdx >= 0 ? Math.max(0, shotP) : t);
  const wantCam = [0, 1, 2].map((i) => mix(cc.from[i], cc.to[i], kk));
  const wantLook = [0, 1, 2].map((i) => mix(cc.lookFrom[i], cc.lookTo[i], kk));
  let sm = s.sm;
  if (!sm.init) sm = { cam: wantCam, look: wantLook, fov: cc.fov, init: true };
  else if (!control) {
    const e = 0.09;
    sm = {
      cam: sm.cam.map((v, i) => v + (wantCam[i] - v) * e),
      look: sm.look.map((v, i) => v + (wantLook[i] - v) * e),
      fov: sm.fov + (cc.fov - sm.fov) * e,
      init: true,
    };
  }
  return {
    sm,
    t,
    yaw,
    pitch: clamp(pitch, -0.15, 1.35),
    dist: clamp(dist, D0 * 0.12, D0 * 3),
    pan: clamp(pan, -12, 12),
    px, py, drag, paused, spaceHeld: space,
    shot, shotP, fade, control,
  };
}

function sunAt(p: number) {
  const s0 = Math.asin(clamp(R.sun.startElev / 62, -1, 1));
  const s1 = Math.asin(clamp(R.sun.endElev / 62, -1, 1));
  const total = R.sun.cycles > 0 ? (s1 - s0) + Math.PI * 2 * R.sun.cycles : s1 - s0;
  const e = R.sun.cycles > 0 ? Math.pow(p, 2.1) : smooth(0, 1, p);
  const ang = s0 + total * e;
  const elev = 62 * Math.sin(ang);
  const rising = Math.cos(ang) >= 0;
  return { elev, rising };
}

function skyFor(elev: number, rising: boolean) {
  if (elev < -4) return R.sky.night;
  if (Math.abs(elev) < 14) return rising ? R.sky.dawn : R.sky.dusk;
  return R.sky.day;
}

const beat = (kind: string) => (R.beats as { t: number; kind: string }[]).find((b) => b.kind === kind)?.t;

const SKIN = "#c8a283";
const wool = (tint: string) => ({
  base_color: tint, // the colour is the tint itself: the texture is dark grey and would crush it, so only its weave is used
  normal_map_texture: tex("poly_wool_herringbone", "nor.jpg"),
  metallic: 0,
  perceptual_roughness: 0.92,
  uv_transform: Affine2.fromScale([3, 3]),
});
const leather = (tint = "#ffffff") => ({
  base_color: tint,
  base_color_texture: tex("brown_leather", "diff.jpg"),
  normal_map_texture: tex("brown_leather", "nor.jpg"),
  metallic_roughness_texture: tex("brown_leather", "arm.jpg"),
  occlusion_texture: tex("brown_leather", "arm.jpg"),
  metallic: 1,
  perceptual_roughness: 1,
  uv_transform: Affine2.fromScale([1.2, 1.2]),
});
const ivory = () => ({
  base_color: "#f3ead3",
  base_color_texture: tex("marble_01", "diff.jpg"),
  normal_map_texture: tex("marble_01", "nor.jpg"),
  metallic_roughness_texture: tex("marble_01", "arm.jpg"),
  occlusion_texture: tex("marble_01", "arm.jpg"),
  metallic: 1,
  perceptual_roughness: 1,
});
const BRASS = { base_color: "#c9953a", metallic: 1, perceptual_roughness: 0.24 };
const NICKEL = { base_color: "#d4d8dc", metallic: 1, perceptual_roughness: 0.16 };

const rot = (x = 0, y = 0, z = 0) => Quat.fromEuler("XYZ", x, y, z);
const at = (x: number, y: number, z: number, q?: any) => (q ? Transform.fromXyz(x, y, z).withRotation(q) : Transform.fromXyz(x, y, z));

// A posable person. Faces +z. Positive X rotation swings a limb backward, so forward is negative.
const PAL: Record<string, any> = {
  man: { coat: "#5d4e3a", vest: "#8f7f5c", pants: "#44444b", shoe: "#2b211a", hair: "#4a3626", shirt: "#ece6d8" },
  woman: { coat: "#3d3445", vest: "#3d3445", pants: "#3d3445", shoe: "#2b211a", hair: "#3a2a22", shirt: "#e9e3d6" },
  eloi: { coat: "#7b4f8c", vest: "#6a4378", pants: "#c8a283", shoe: "#8a6a48", hair: "#d8b968", shirt: "#7b4f8c" },
  generic: { coat: "#5a5a60", vest: "#6a6a70", pants: "#3e3e44", shoe: "#2b211a", hair: "#3a2e26", shirt: "#e3ddd0" },
};

/** The face's expression from the scene's mood word(s): brow tilt (inner ends up = worry), brow lift, smile (-1 frown .. 1 smile), open mouth. */
function exprOf(mood: string): { tilt: number; lift: number; smile: number; open: number } {
  const m = (mood ?? "").toLowerCase();
  if (/dread|fear|terror|panic|horror|alarm|tense|anxious|uneasy|menace|suspense/.test(m)) return { tilt: 0.28, lift: 0.006, smile: -0.4, open: 0.35 };
  if (/wonder|awe|amaz|surreal|strange|marvel|curious|uncanny|dream/.test(m)) return { tilt: 0.05, lift: 0.01, smile: 0.1, open: 0.5 };
  if (/joy|happy|delight|warm|cheer|triumph|relief|hope|fond|playful|bright/.test(m)) return { tilt: -0.04, lift: 0.004, smile: 0.9, open: 0.1 };
  if (/sad|grief|melan|lonely|despair|forlorn|sorrow|loss|bleak|mourn|desolat/.test(m)) return { tilt: 0.3, lift: -0.002, smile: -0.8, open: 0 };
  if (/anger|fury|rage|hostile|determin|fierce|grim|resolve|struggle|violent/.test(m)) return { tilt: -0.3, lift: -0.004, smile: -0.5, open: 0.1 };
  return { tilt: 0, lift: 0, smile: 0.1, open: 0 };
}
const EXPR = exprOf(R.mood);

function Figure({ fig, f, p, leverA = 0 }: { fig: any; f: number; p: number; leverA?: number }) {
  const eloi = fig.kind === "eloi";
  const woman = fig.kind === "woman";
  const man = !eloi && !woman;
  const C = PAL[fig.kind] ?? PAL.generic;
  const skin = { base_color: SKIN, perceptual_roughness: 0.62 };
  const hairM = { base_color: C.hair, perceptual_roughness: 0.82 };
  const hipY = 0.98;
  const ph = f * 0.3;
  const sw = Math.sin(ph);
  const breathe = Math.sin(f * 0.07) * 0.012;
  // what the character is doing right now: the base pose, then their acting cues (sit, stand, walk_to, reach...) blended over time
  const acts: any[] = fig.acts ?? [];
  let pose: string = fig.pose;
  let from: string = fig.pose;
  let k = 1;
  let ax = fig.walk ? mix(fig.walk[0], fig.walk[2], p) : fig.x;
  let az = fig.walk ? mix(fig.walk[1], fig.walk[3], p) : fig.z;
  let yawA: number = fig.yaw;
  let reachR = 0;
  let lever = 0;
  let wave = 0;
  let look = 0;
  for (const a of acts) {
    if (p < a.p0) break;
    const q = clamp((p - a.p0) / Math.max(1e-4, a.p1 - a.p0));
    const env = smooth(0, 0.18, q) * (1 - smooth(0.82, 1, q));
    if (a.do === "sit" || a.do === "stand" || a.do === "crouch") {
      from = pose;
      pose = a.do === "sit" ? "seated" : a.do === "crouch" ? "crouch" : "standing";
      k = smooth(a.p0, a.p0 + 0.035, p);
    } else if (a.do === "walk_to" && a.tx !== undefined && a.tz !== undefined) {
      const sx = ax;
      const sz = az;
      yawA = Math.atan2(a.tx - sx, a.tz - sz);
      if (q < 1) {
        ax = mix(sx, a.tx, smooth(0, 1, q));
        az = mix(sz, a.tz, smooth(0, 1, q));
        from = pose === "walking" ? from : pose;
        pose = "walking";
        k = smooth(a.p0, a.p0 + 0.03, p);
      } else {
        ax = a.tx;
        az = a.tz;
        from = "walking";
        pose = "standing";
        k = smooth(a.p1, a.p1 + 0.03, p);
      }
    } else if (a.do === "turn" && a.tx !== undefined && a.tz !== undefined) {
      yawA = mix(yawA, Math.atan2(a.tx - ax, a.tz - az), smooth(a.p0, a.p0 + 0.04, p));
    } else if (a.do === "look_at") look = env * (a.tx !== undefined && a.tx < ax ? -1 : 1);
    else if (a.do === "reach") reachR = env;
    else if (a.do === "use_lever") lever = env;
    else if (a.do === "gesture") wave = env;
  }
  const walking = pose === "walking" || (from === "walking" && k < 0.5);
  const seated = pose === "seated" || (from === "seated" && k < 0.5);
  const crouch = pose === "crouch";
  // sitting with no machine under him: on a bench or chair if one stands right there, otherwise on the ground (legs out front)
  const nearSeat = !fig.onMachine && (R.assets as any[]).some((a) => /bench|chair|stool|seat|sofa|couch/.test(a.label ?? "") && Math.hypot(a.pos[0] - ax, a.pos[2] - az) < 1.2);
  const gnd = !fig.onMachine && !nearSeat;
  // reaching for the lever: the right arm follows its angle, the left rests on the other lever
  const reach = seated ? 0.3 * leverA : 0;
  const poseA = (name: string) => {
    const w = name === "walking";
    const sd = name === "seated";
    const cr = name === "crouch";
    const g = sd && gnd;
    return {
      hipL: w ? -0.55 * sw : g ? -1.5 : sd ? -1.42 : cr ? -1.25 : 0.03,
      hipR: w ? 0.55 * sw : g ? -1.5 : sd ? -1.42 : cr ? -1.25 : -0.03,
      kneeL: w ? 0.12 + 0.65 * Math.max(0, Math.cos(ph)) : g ? 0.15 : sd ? 1.35 : cr ? 2.2 : 0.06,
      kneeR: w ? 0.12 + 0.65 * Math.max(0, -Math.cos(ph)) : g ? 0.25 : sd ? 1.35 : cr ? 2.2 : 0.08,
      shL: w ? 0.42 * sw : g ? 0.5 : sd ? -0.9 : cr ? -0.5 : -0.05 + Math.sin(f * 0.04) * 0.012,
      shR: w ? -0.42 * sw : g ? 0.4 : sd ? -0.9 - reach : cr ? -0.5 : -0.07 - Math.sin(f * 0.04) * 0.012,
      elL: w ? -0.3 : g ? -0.25 : sd ? -0.85 : -0.22,
      elR: w ? -0.3 : g ? -0.25 : sd ? -0.85 + reach * 0.8 : -0.25,
      lean: g ? 0.04 : sd ? -0.12 : cr ? -0.35 : w ? -0.06 : 0,
      twist: w ? 0.09 * sw : 0,
      root: sd ? (g ? 0.1 : nearSeat ? 0.5 : 0.78) - hipY : cr ? -0.42 : 0,
    };
  };
  const PA = poseA(from);
  const PB = poseA(pose);
  const A = { hipL: mix(PA.hipL, PB.hipL, k), hipR: mix(PA.hipR, PB.hipR, k), kneeL: mix(PA.kneeL, PB.kneeL, k), kneeR: mix(PA.kneeR, PB.kneeR, k), shL: mix(PA.shL, PB.shL, k), shR: mix(PA.shR, PB.shR, k), elL: mix(PA.elL, PB.elL, k), elR: mix(PA.elR, PB.elR, k), lean: mix(PA.lean, PB.lean, k), twist: mix(PA.twist, PB.twist, k) };
  // transient gestures on top
  A.shR += -1.35 * reachR - 0.9 * lever;
  A.elR += -0.25 * reachR + 0.3 * lever;
  A.lean += -0.1 * lever + 0.04 * reachR;
  if (wave > 0.001) {
    A.shR = mix(A.shR, -2.4 + Math.sin(f * 0.4) * 0.35, wave);
    A.elR = mix(A.elR, -1.1 + Math.sin(f * 0.4) * 0.4, wave);
  }
  const bob = walking ? Math.abs(Math.cos(ph)) * 0.03 : Math.sin(f * 0.05) * 0.004;
  const sway = walking ? Math.sin(ph) * 0.02 : Math.sin(f * 0.03) * 0.008;
  const rootY = mix(PA.root, PB.root, k) + bob;
  const px = ax + sway;
  const pz = az;
  const sc = fig.scale;
  // blinking: every few seconds, a quick close (each figure on its own beat)
  const bt = (f + (fig.x * 37 + 11) * 13) % (96 + ((fig.z * 29) | 0 & 15));
  const bl = bt < 5 ? Math.sin((Math.PI * bt) / 5) : 0;
  const headYaw = Math.sin(f * 0.02 + 1) * 0.14 + (seated ? 0 : -0.05) + look * 0.8;
  const headPitch = seated ? 0.12 + 0.08 * Math.abs(leverA) : 0.03 + Math.sin(f * 0.031) * 0.02;
  const tailSwing = 0.12 + (walking ? 0.25 * Math.abs(sw) : 0) + Math.sin(f * 0.05) * 0.02;

  const Leg = ({ x, hip, knee, ank }: { x: number; hip: number; knee: number; ank: number }) => (
    <Entity transform={at(x, hipY, 0, rot(hip))}>
      <Mesh3d transform={at(0, -0.22, 0).withScale([1.12, 1, 1.1])}>
        <Capsule3d radius={0.08} half_length={0.15} />
        <StandardMaterial {...(eloi ? skin : wool(C.pants))} />
      </Mesh3d>
      <Entity transform={at(0, -0.45, 0, rot(knee))}>
        <Mesh3d>
          <Sphere radius={0.066} />
          <StandardMaterial {...(eloi ? skin : wool(C.pants))} />
        </Mesh3d>
        <Mesh3d transform={at(0, -0.225, 0).withScale([1, 1, 1.05])}>
          <Capsule3d radius={0.063} half_length={0.165} />
          <StandardMaterial {...(eloi ? skin : wool(C.pants))} />
        </Mesh3d>
        {!eloi ? (
          <Mesh3d transform={at(0, -0.435, 0)}>
            <Cylinder radius={0.064} half_height={0.03} />
            <StandardMaterial {...wool(C.pants)} />
          </Mesh3d>
        ) : null}
        <Entity transform={at(0, -0.46, 0.0, rot(ank))}>
          <Mesh3d transform={at(0, -0.02, 0.07)}>
            <Cuboid half_size={[0.045, 0.028, 0.1]} />
            <StandardMaterial {...leather(eloi ? "#b08a5a" : "#4a3a2e")} />
          </Mesh3d>
          <Mesh3d transform={at(0, -0.02, 0.17)}>
            <Sphere radius={0.045} />
            <StandardMaterial {...leather(eloi ? "#b08a5a" : "#4a3a2e")} />
          </Mesh3d>
          <Mesh3d transform={at(0, -0.045, -0.02)}>
            <Cuboid half_size={[0.04, 0.018, 0.035]} />
            <StandardMaterial base_color={C.shoe} perceptual_roughness={0.6} />
          </Mesh3d>
        </Entity>
      </Entity>
    </Entity>
  );

  const Arm = ({ x, sh, el }: { x: number; sh: number; el: number }) => (
    <Entity transform={at(x, 0.5, 0, rot(sh, 0, x < 0 ? 0.04 : -0.04))}>
      <Mesh3d>
        <Sphere radius={0.052} />
        <StandardMaterial {...wool(C.coat)} />
      </Mesh3d>
      <Mesh3d transform={at(0, -0.15, 0).withScale([1.05, 1, 1.05])}>
        <Capsule3d radius={0.05} half_length={0.105} />
        <StandardMaterial {...wool(C.coat)} />
      </Mesh3d>
      <Entity transform={at(0, -0.3, 0, rot(el))}>
        <Mesh3d>
          <Sphere radius={0.047} />
          <StandardMaterial {...wool(C.coat)} />
        </Mesh3d>
        <Mesh3d transform={at(0, -0.14, 0)}>
          <Capsule3d radius={0.043} half_length={0.1} />
          <StandardMaterial {...wool(woman || eloi ? C.coat : C.coat)} />
        </Mesh3d>
        {man ? (
          <Mesh3d transform={at(0, -0.255, 0)}>
            <Cylinder radius={0.04} half_height={0.012} />
            <StandardMaterial base_color={C.shirt} perceptual_roughness={0.7} />
          </Mesh3d>
        ) : null}
        <Mesh3d transform={at(0, -0.31, 0.005).withScale([0.95, 1.25, 0.6])}>
          <Sphere radius={0.04} />
          <StandardMaterial {...skin} />
        </Mesh3d>
        <Mesh3d transform={at(0.03 * (x < 0 ? 1 : -1), -0.29, 0.03)}>
          <Sphere radius={0.016} />
          <StandardMaterial {...skin} />
        </Mesh3d>
      </Entity>
    </Entity>
  );

  return (
    <Entity transform={at(px, rootY, pz, rot(0, yawA)).withScale([sc, sc, sc])}>
      <Leg x={-0.095} hip={A.hipL} knee={A.kneeL} ank={walking ? -A.hipL * 0.4 : seated ? 0.1 : 0} />
      <Leg x={0.095} hip={A.hipR} knee={A.kneeR} ank={walking ? -A.hipR * 0.4 : seated ? 0.1 : 0} />
      {/* pelvis */}
      <Mesh3d transform={at(0, hipY + 0.02, 0).withScale([1.3, 0.9, 0.95])}>
        <Sphere radius={0.14} />
        <StandardMaterial {...wool(woman ? C.coat : C.pants)} />
      </Mesh3d>
      <Entity transform={at(0, hipY, 0, rot(A.lean, A.twist, 0))}>
        {/* waist, chest, shoulders */}
        <Mesh3d transform={at(0, 0.13, 0).withScale([1, 1, 0.8])}>
          <Capsule3d radius={0.125} half_length={0.07} />
          <StandardMaterial {...wool(C.coat)} />
        </Mesh3d>
        <Mesh3d transform={at(0, 0.36, 0.005).withScale([1.08, 1 + breathe, 0.84 + breathe])}>
          <Capsule3d radius={0.138} half_length={0.09} />
          <StandardMaterial {...wool(C.coat)} />
        </Mesh3d>
        {/* the shoulder line: a yoke joining chest and arms, so the arms hang from the body and not from balls */}
        <Mesh3d transform={at(0, 0.5, 0, rot(0, 0, Math.PI / 2)).withScale([1, 1, 0.78])}>
          <Capsule3d radius={0.058} half_length={0.125} />
          <StandardMaterial {...wool(C.coat)} />
        </Mesh3d>
        {man ? (
          <>
            {/* waistcoat, shirt collar, cravat, lapels */}
            <Mesh3d transform={at(0, 0.33, 0.118)}>
              <Cuboid half_size={[0.062, 0.14, 0.012]} />
              <StandardMaterial {...wool(C.vest)} />
            </Mesh3d>
            <Mesh3d transform={at(0, 0.56, 0.01)}>
              <Cylinder radius={0.058} half_height={0.022} />
              <StandardMaterial base_color={C.shirt} perceptual_roughness={0.7} />
            </Mesh3d>
            <Mesh3d transform={at(0, 0.5, 0.108)}>
              <Cuboid half_size={[0.028, 0.045, 0.014]} />
              <StandardMaterial base_color="#3a2a38" perceptual_roughness={0.5} />
            </Mesh3d>
            {[-1, 1].map((sd) => (
              <Mesh3d key={sd} transform={at(sd * 0.06, 0.43, 0.118, rot(0, 0, sd * -0.35))}>
                <Cuboid half_size={[0.014, 0.1, 0.01]} />
                <StandardMaterial {...wool(C.coat)} />
              </Mesh3d>
            ))}
            {/* coat tails */}
            {[-1, 1].map((sd) => (
              <Entity key={sd} transform={at(sd * 0.06, 0.02, -0.1, rot(tailSwing))}>
                <Mesh3d transform={at(0, -0.17, 0)}>
                  <Cuboid half_size={[0.055, 0.17, 0.012]} />
                  <StandardMaterial {...wool(C.coat)} />
                </Mesh3d>
              </Entity>
            ))}
          </>
        ) : null}
        {woman ? (
          <>
            <Mesh3d transform={at(0, -0.37, 0)}>
              <Cone radius={0.37} height={0.9} />
              <StandardMaterial {...wool(C.coat)} />
            </Mesh3d>
            <Mesh3d transform={at(0, 0.1, 0.11)}>
              <Cuboid half_size={[0.1, 0.34, 0.01]} />
              <StandardMaterial base_color="#ece7dc" perceptual_roughness={0.75} />
            </Mesh3d>
            <Mesh3d transform={at(0, 0.56, 0.01)}>
              <Cylinder radius={0.06} half_height={0.02} />
              <StandardMaterial base_color={C.shirt} perceptual_roughness={0.7} />
            </Mesh3d>
          </>
        ) : null}
        {eloi ? (
          <>
            <Mesh3d transform={at(0, -0.12, 0)}>
              <Cylinder radius={0.2} half_height={0.2} />
              <StandardMaterial {...wool(C.coat)} />
            </Mesh3d>
            <Mesh3d transform={at(0, 0.1, 0)}>
              <Cylinder radius={0.135} half_height={0.02} />
              <StandardMaterial {...leather("#7a5a3a")} />
            </Mesh3d>
          </>
        ) : null}
        {/* neck and head */}
        <Mesh3d transform={at(0, 0.6, 0)}>
          <Cylinder radius={0.05} half_height={0.04} />
          <StandardMaterial {...skin} />
        </Mesh3d>
        <Entity transform={at(0, 0.665, 0, rot(headPitch, headYaw, 0))}>
          {/* skull and jaw: the face's features sit on their front surface (z about 0.09 to 0.105 at the middle) */}
          <Mesh3d transform={at(0, 0.1, 0).withScale([0.92, 1.08, 1])}>
            <Sphere radius={0.1} />
            <StandardMaterial {...skin} />
          </Mesh3d>
          <Mesh3d transform={at(0, 0.03, 0.012).withScale([0.8, 0.78, 0.78])}>
            <Sphere radius={0.088} />
            <StandardMaterial {...skin} />
          </Mesh3d>
          {/* nose: a bridge and a rounded tip, with dark nostrils */}
          <Mesh3d transform={at(0, 0.094, 0.094).withScale([0.8, 1.3, 1])}>
            <Sphere radius={0.0095} />
            <StandardMaterial {...skin} />
          </Mesh3d>
          <Mesh3d transform={at(0, 0.077, 0.1).withScale([1.15, 0.9, 1])}>
            <Sphere radius={0.0105} />
            <StandardMaterial {...skin} />
          </Mesh3d>
          {[-1, 1].map((sd) => (
            <Mesh3d key={"n" + sd} transform={at(sd * 0.0055, 0.072, 0.1075)}>
              <Sphere radius={0.0022} />
              <StandardMaterial base_color="#3a2420" perceptual_roughness={0.8} />
            </Mesh3d>
          ))}
          {[-1, 1].map((sd) => (
            <Entity key={sd} transform={at(0, 0, 0)}>
              {/* eye: white, iris, pupil, a catch-light, and a lid over the top */}
              <Mesh3d transform={at(sd * 0.037, 0.117, 0.087).withScale([1.15, 0.82 * (1 - 0.9 * bl), 0.6])}>
                <Sphere radius={0.0135} />
                <StandardMaterial base_color="#f2eee4" perceptual_roughness={0.25} />
              </Mesh3d>
              <Mesh3d transform={at(sd * 0.0365, 0.117, 0.0945).withScale([1, 1 - 0.9 * bl, 0.45])}>
                <Sphere radius={0.0075} />
                <StandardMaterial base_color={eloi ? "#5f86ad" : "#4a3626"} perceptual_roughness={0.2} />
              </Mesh3d>
              <Mesh3d transform={at(sd * 0.0365, 0.117, 0.0968).withScale([1, 1 - 0.9 * bl, 0.4])}>
                <Sphere radius={0.0038} />
                <StandardMaterial base_color="#0b0907" perceptual_roughness={0.15} />
              </Mesh3d>
              <Mesh3d transform={at(sd * 0.0345, 0.1195, 0.0985)}>
                <Sphere radius={0.0017} />
                <StandardMaterial base_color="#ffffff" perceptual_roughness={0.1} />
              </Mesh3d>
              <Mesh3d transform={at(sd * 0.037, 0.1245 - 0.006 * bl, 0.0865).withScale([1.25, 0.5 + 1.1 * bl, 0.62])}>
                <Sphere radius={0.0145} />
                <StandardMaterial {...skin} />
              </Mesh3d>
              {/* brow, tilted with the expression */}
              <Mesh3d transform={at(sd * 0.038, 0.1385 + EXPR.lift, 0.0865, rot(0, 0, sd * (-0.07 - EXPR.tilt)))}>
                <Cuboid half_size={[0.019, 0.003, 0.005]} />
                <StandardMaterial {...hairM} />
              </Mesh3d>
              {/* ear */}
              <Mesh3d transform={at(sd * 0.092, 0.1, 0.0).withScale([0.55, 1, 0.8])}>
                <Sphere radius={0.02} />
                <StandardMaterial {...skin} />
              </Mesh3d>
            </Entity>
          ))}
          {/* mouth: lips with a dark line between them */}
          <Mesh3d transform={at(0, 0.0565, 0.0975).withScale([1.2 * (1 + 0.25 * EXPR.smile), 0.3, 0.45])}>
            <Sphere radius={0.0135} />
            <StandardMaterial base_color="#a35f58" perceptual_roughness={0.45} />
          </Mesh3d>
          <Mesh3d transform={at(0, 0.0475 - 0.008 * EXPR.open, 0.0965).withScale([1.05 * (1 + 0.25 * EXPR.smile), 0.32, 0.45])}>
            <Sphere radius={0.0135} />
            <StandardMaterial base_color="#b0685f" perceptual_roughness={0.4} />
          </Mesh3d>
          <Mesh3d transform={at(0, 0.0522 - 0.004 * EXPR.open, 0.1)}>
            <Cuboid half_size={[0.015 * (1 + 0.25 * EXPR.smile), 0.0011 + 0.0045 * EXPR.open, 0.0012]} />
            <StandardMaterial base_color="#3d2321" perceptual_roughness={0.6} />
          </Mesh3d>
          {[-1, 1].map((sd) => (
            <Mesh3d key={"mc" + sd} transform={at(sd * 0.0165 * (1 + 0.25 * EXPR.smile), 0.0522 + 0.0065 * EXPR.smile, 0.0985)}>
              <Sphere radius={0.0022} />
              <StandardMaterial base_color="#a35f58" perceptual_roughness={0.45} />
            </Mesh3d>
          ))}
          {/* hair */}
          <Mesh3d transform={at(0, 0.17, -0.03).withScale([1, 0.7, 1])}>
            <Sphere radius={0.106} />
            <StandardMaterial {...hairM} />
          </Mesh3d>
          {man ? (
            <Mesh3d transform={at(0, 0.12, -0.06).withScale([0.95, 1, 0.8])}>
              <Sphere radius={0.1} />
              <StandardMaterial {...hairM} />
            </Mesh3d>
          ) : null}
          {woman ? (
            <>
              <Mesh3d transform={at(0, 0.2, -0.09)}>
                <Sphere radius={0.055} />
                <StandardMaterial {...hairM} />
              </Mesh3d>
              <Mesh3d transform={at(0, 0.1, -0.05).withScale([1.05, 1.1, 0.85])}>
                <Sphere radius={0.1} />
                <StandardMaterial {...hairM} />
              </Mesh3d>
            </>
          ) : null}
          {eloi ? (
            <Mesh3d transform={at(0, 0.11, -0.04).withScale([1.2, 1.15, 1.15])}>
              <Sphere radius={0.105} />
              <StandardMaterial {...hairM} />
            </Mesh3d>
          ) : null}
        </Entity>
        <Arm x={-0.185} sh={A.shL} el={A.elL} />
        <Arm x={0.185} sh={A.shR} el={A.elR} />
      </Entity>
    </Entity>
  );
}

function Machine({ p, f }: { p: number; f: number }) {
  const lever = beat("lever");
  const glowK = 0.8 + 7 * smooth(lever ?? 0, (lever ?? 0) + 0.25, p);
  const tumbleAt = beat("tumble");
  const tum = tumbleAt === undefined ? 0 : smooth(tumbleAt, tumbleAt + 0.12, p);
  const speed = R.sun.cycles > 0 ? smooth(0.1, 0.8, p) : 0;
  const rock = Math.sin(f * 0.9) * 0.03 * speed;
  const leverA = lever === undefined ? -0.5 : mix(-0.55, 0.5, smooth(lever, lever + 0.08, p));
  const dial = (R.sun.cycles > 0 ? p * p * 60 : p * 2) + f * 0.01;
  const rider = (R.figures as any[]).find((x) => x.onMachine);
  return (
    <Entity transform={at(tum * 1.6, 0.05 + tum * 0.1, tum * 0.8, rot(0, rock * 2, rock + tum * 1.25))}>
      {/* base: walnut deck on brass runners */}
      <Mesh3d transform={at(0, 0.34, 0)}>
        <Cuboid half_size={[1.0, 0.04, 0.62]} />
        <StandardMaterial base_color="#4a2f1d" perceptual_roughness={0.45} />
      </Mesh3d>
      {[-0.55, 0.55].map((z) => (
        <Mesh3d key={z} transform={at(0, 0.27, z).withRotation(rot(0, 0, Math.PI / 2))}>
          <Cylinder radius={0.035} half_height={1.08} />
          <StandardMaterial {...BRASS} />
        </Mesh3d>
      ))}
      {[-0.8, 0, 0.8].map((x) => (
        <Mesh3d key={x} transform={at(x, 0.2, 0)}>
          <Cuboid half_size={[0.03, 0.07, 0.6]} />
          <StandardMaterial {...BRASS} />
        </Mesh3d>
      ))}
      {/* ivory uprights with brass caps, nickel rails between */}
      {[[-0.85, -0.5], [-0.85, 0.5], [0.85, -0.5], [0.85, 0.5]].map(([x, z], i) => (
        <Entity key={i} transform={at(x, 0, z)}>
          <Mesh3d transform={at(0, 0.82, 0)}>
            <Cylinder radius={0.032} half_height={0.45} />
            <StandardMaterial {...ivory()} />
          </Mesh3d>
          <Mesh3d transform={at(0, 1.29, 0)}>
            <Sphere radius={0.05} />
            <StandardMaterial {...BRASS} />
          </Mesh3d>
          <Mesh3d transform={at(0, 0.37, 0)}>
            <Cylinder radius={0.05} half_height={0.03} />
            <StandardMaterial {...BRASS} />
          </Mesh3d>
        </Entity>
      ))}
      {[-0.5, 0.5].map((z) => (
        <Mesh3d key={z} transform={at(0, 1.2, z).withRotation(rot(0, 0, Math.PI / 2))}>
          <Cylinder radius={0.018} half_height={0.85} />
          <StandardMaterial {...NICKEL} />
        </Mesh3d>
      ))}
      {/* quartz rods: glass sleeve around a glowing core */}
      {[-0.28, 0.28].map((x) => (
        <Entity key={x} transform={at(x, 0.9, -0.44)}>
          <Mesh3d shadow={false}>
            <Cylinder radius={0.05} half_height={0.5} />
            <StandardMaterial base_color={Srgba.hex("#cfeeff").with_alpha(0.28)} alpha_mode="Blend" perceptual_roughness={0.04} />
          </Mesh3d>
          <Mesh3d shadow={false}>
            <Cylinder radius={0.022} half_height={0.48} />
            <StandardMaterial base_color="#e6fbff" unlit emissive={glow("#8ee8ff", glowK)} />
          </Mesh3d>
        </Entity>
      ))}
      {/* saddle on a post */}
      <Mesh3d transform={at(0, 0.5, 0.02)}>
        <Cylinder radius={0.05} half_height={0.16} />
        <StandardMaterial {...NICKEL} />
      </Mesh3d>
      <Mesh3d transform={at(0, 0.7, 0.04).withScale([0.34, 0.09, 0.42])}>
        <Sphere radius={1} />
        <StandardMaterial {...leather()} />
      </Mesh3d>
      {/* instrument post with two dials and two levers */}
      <Mesh3d transform={at(0, 0.62, 0.5)}>
        <Cuboid half_size={[0.34, 0.16, 0.05]} />
        <StandardMaterial base_color="#3a2418" perceptual_roughness={0.4} />
      </Mesh3d>
      {[-0.17, 0.17].map((x, i) => (
        <Entity key={x} transform={at(x, 0.66, 0.56)}>
          <Mesh3d transform={at(0, 0, 0).withRotation(rot(Math.PI / 2, 0, 0))}>
            <Cylinder radius={0.1} half_height={0.012} />
            <StandardMaterial base_color="#f1e8cf" perceptual_roughness={0.3} />
          </Mesh3d>
          <Mesh3d transform={at(0, 0, 0).withRotation(rot(Math.PI / 2, 0, 0))}>
            <Torus major_radius={0.1} minor_radius={0.012} />
            <StandardMaterial {...BRASS} />
          </Mesh3d>
          <Mesh3d transform={at(Math.cos(dial * (i ? 1 : 0.37)) * 0.06, Math.sin(dial * (i ? 1 : 0.37)) * 0.06, 0.02)} shadow={false}>
            <Cuboid half_size={[0.006, 0.006, 0.004]} />
            <StandardMaterial base_color="#ff5a3c" unlit emissive={glow("#ff5a3c", 4)} />
          </Mesh3d>
        </Entity>
      ))}
      {[-0.12, 0.12].map((x, i) => (
        <Entity key={x} transform={at(x, 0.45, 0.5, rot(i ? leverA : -leverA * 0.8, 0, 0))}>
          <Mesh3d transform={at(0, 0.17, 0)}>
            <Cylinder radius={0.012} half_height={0.17} />
            <StandardMaterial {...NICKEL} />
          </Mesh3d>
          <Mesh3d transform={at(0, 0.36, 0)}>
            <Sphere radius={0.032} />
            <StandardMaterial {...BRASS} />
          </Mesh3d>
        </Entity>
      ))}
      {rider ? (
        <Entity transform={at(0, 0, 0.0)}>
          <Figure fig={{ ...rider, x: 0, z: 0.02, walk: null, yaw: 0 }} f={f} p={p} leverA={leverA} />
        </Entity>
      ) : null}
    </Entity>
  );
}

function Sphinx() {
  return (
    <Entity transform={Transform.fromXyz(-4, 0, -9)}>
      <Mesh3d transform={Transform.fromXyz(0, 0.9, 0)}>
        <Cuboid half_size={[2.2, 0.9, 1.5]} />
        <StandardMaterial base_color="#4f7a66" metallic={0.7} perceptual_roughness={0.45} />
      </Mesh3d>
      <Mesh3d transform={Transform.fromXyz(0, 2.4, 0.2)}>
        <Cuboid half_size={[1.5, 0.9, 1.0]} />
        <StandardMaterial base_color="#e9e6df" perceptual_roughness={0.55} />
      </Mesh3d>
      <Mesh3d transform={Transform.fromXyz(0, 3.7, 0.9)}>
        <Sphere radius={0.7} />
        <StandardMaterial base_color="#ebe8e1" perceptual_roughness={0.5} />
      </Mesh3d>
      {[-1, 1].map((s) => (
        <Mesh3d key={s} transform={Transform.fromXyz(s * 1.5, 3.2, -0.6).withRotation(Quat.fromEuler("XYZ", 0, 0, s * 0.5))}>
          <Cuboid half_size={[0.12, 1.1, 0.9]} />
          <StandardMaterial base_color="#e4e1d9" perceptual_roughness={0.6} />
        </Mesh3d>
      ))}
    </Entity>
  );
}

function Rain({ f, heavy }: { f: number; heavy: boolean }) {
  const n = heavy ? 90 : 55;
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const a = (i * 2.399) % (Math.PI * 2);
        const r = 2 + ((i * 0.618) % 1) * 9;
        const y = 9 - ((f * 0.7 + i * 1.7) % 9.5);
        return (
          <Mesh3d key={i} shadow={false} transform={Transform.fromXyz(Math.cos(a) * r, y, Math.sin(a) * r - 1)}>
            <Cylinder radius={0.012} half_height={0.35} />
            <StandardMaterial base_color="#d8e6ff" unlit emissive={glow("#b8d4ff", 1.6)} />
          </Mesh3d>
        );
      })}
    </>
  );
}

function Room() {
  const { w, d, h } = R.room;
  const wall = { base_color: "#bda98c", perceptual_roughness: 0.95 };
  const T = 0.1;
  return (
    <>
      <Mesh3d transform={Transform.fromXyz(0, 0, 0)}>
        <Plane3d normal={[0, 1, 0]} half_size={[w / 2, d / 2]} />
        <StandardMaterial
          base_color_texture={tex(R.room.floor, "diff.jpg")}
          normal_map_texture={tex(R.room.floor, "nor.jpg")}
          metallic_roughness_texture={tex(R.room.floor, "arm.jpg")}
          occlusion_texture={tex(R.room.floor, "arm.jpg")}
          metallic={1}
          perceptual_roughness={1}
          uv_transform={Affine2.fromScale([w / 1.6, d / 1.6])}
        />
      </Mesh3d>
      {/* walls and ceiling are thin solid boxes, not planes: a zero-thickness plane lets the sun's shadow map leak through in
          square speckles all over everything inside. They sit just outside the room's edge. */}
      <Mesh3d transform={Transform.fromXyz(0, h / 2, -d / 2 - T)}>
        <Cuboid half_size={[w / 2 + 2 * T, h / 2, T]} />
        <StandardMaterial {...wall} />
      </Mesh3d>
      <Mesh3d transform={Transform.fromXyz(-w / 2 - T, h / 2, 0)}>
        <Cuboid half_size={[T, h / 2, d / 2]} />
        <StandardMaterial {...wall} />
      </Mesh3d>
      <Mesh3d transform={Transform.fromXyz(w / 2 + T, h / 2, 0)}>
        <Cuboid half_size={[T, h / 2, d / 2]} />
        <StandardMaterial {...wall} />
      </Mesh3d>
      <Mesh3d transform={Transform.fromXyz(0, h / 2, d / 2 + T)}>
        <Cuboid half_size={[w / 2 + 2 * T, h / 2, T]} />
        <StandardMaterial {...wall} />
      </Mesh3d>
      <Mesh3d transform={Transform.fromXyz(0, h + T, 0)}>
        <Cuboid half_size={[w / 2 + 2 * T, T, d / 2 + 2 * T]} />
        <StandardMaterial base_color="#a89a82" perceptual_roughness={1} />
      </Mesh3d>
    </>
  );
}

// ---- stage: cues the story directs (R.stage), played by the reader's position (p = the world's progress through its text, 0..1)
type V3 = [number, number, number];
const cueQ = (c: any, p: number) => clamp((p - c.p0) / Math.max(1e-4, c.p1 - c.p0));
const bell = (q: number) => Math.sin(Math.PI * clamp(q));
let widenS = 0; // how much extra room the camera is asked to give (0..1.5), eased
const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vnorm = (a: V3): V3 => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rr = (i: number, k: number) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
const backOut = (x: number) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
/** A point in the sky, far off, in the direction az (radians from +Z toward +X; forward is -Z) and elevation el (radians). */
const skyPoint = (cam: V3, az: number, el: number, dist = 55): V3 => [cam[0] + Math.sin(az) * Math.cos(el) * dist, cam[1] + Math.sin(el) * dist, cam[2] - Math.cos(az) * Math.cos(el) * dist];
const moonAt = (c: any, q: number, cam: V3): V3 => skyPoint(cam, c.az + (q - 0.5) * 0.35, (c.el + 6 * bell(q)) * D2R);

/** The moon, a card showing one of 16 generated phase pictures (runtime/moon/, made by scripts/make-moon.py):
 *  unlit, so the sun doesn't wash it out, with a real terminator and maria. new at ph 0, full at ph 1. */
function Moon({ c, p, cam }: { c: any; p: number; cam: V3 }) {
  const q = cueQ(c, p);
  const vis = smooth(0, 0.1, q) * (1 - smooth(0.9, 1, q));
  if (vis < 0.01) return null;
  const pos = moonAt(c, q, cam);
  const ph = mix(c.ph[0], c.ph[1], smooth(0, 1, q));
  const size = 9.6 * (0.55 + 0.45 * vis);
  const away: V3 = [pos[0] * 2 - cam[0], pos[1] * 2 - cam[1], pos[2] * 2 - cam[2]]; // looking away from us turns the card's face toward us
  const cell = Math.round(clamp(ph) * 15);
  return (
    <Entity transform={Transform.fromXyz(...pos).lookingAt(away)}>
      {/* a cut-out card (alpha mask), not a blended one: a blended card's clear corners pick up the fog and show as a box */}
      <Mesh3d shadow={false}>
        <Plane3d normal={[0, 0, 1]} half_size={[size / 2, size / 2]} />
        <StandardMaterial base_color_texture={media(`lanthorn/moon/moon_${String(cell).padStart(2, "0")}.png`)} unlit alpha_mode={{ Mask: 0.5 }} double_sided />
      </Mesh3d>
    </Entity>
  );
}

/** A streak of fire across the sky, with a trail: the sun racing through its days. */
function SunStreak({ c, p, cam }: { c: any; p: number; cam: V3 }) {
  const q = cueQ(c, p);
  const vis = smooth(0, 0.06, q) * (1 - smooth(0.94, 1, q));
  if (vis < 0.01) return null;
  return (
    <>
      {Array.from({ length: 14 }, (_, k) => {
        const u = clamp(q - k * 0.03);
        const pt = skyPoint(cam, c.az + u * 2.6, (c.el + 62 * Math.sin(Math.PI * u)) * D2R, 60);
        const sz = 2.6 * (1 - k * 0.055) * vis;
        return (
          <Mesh3d key={k} shadow={false} transform={at(...pt)}>
            <Sphere radius={Math.max(0.1, sz)} />
            <StandardMaterial base_color="#ffd9a0" unlit emissive={glow(k === 0 ? "#ffcf7a" : "#ff8a3c", 7 - k * 0.45)} />
          </Mesh3d>
        );
      })}
    </>
  );
}

const isRedSun = (c: any) => /red|halt|huge|giant|set|dying|low/.test(c.how ?? "");

/** A huge red sun hanging low: the dying sun of the far future. */
function RedSun({ c, p, cam, f }: { c: any; p: number; cam: V3; f: number }) {
  const q = cueQ(c, p);
  const vis = smooth(0, 0.12, q) * (1 - smooth(0.88, 1, q));
  if (vis < 0.01) return null;
  const pt = skyPoint(cam, c.az, c.el * D2R, 70);
  const r = 13 * (0.6 + 0.4 * vis);
  const pulse = 1 + 0.06 * Math.sin(f * 0.07);
  return (
    <>
      {[2.4, 1.95, 1.6, 1.3].map((k, i) => (
        <Mesh3d key={i} shadow={false} transform={at(...pt)}>
          <Sphere radius={r * k} />
          <StandardMaterial base_color={Srgba.hex("#ff6a3a").with_alpha(0.05 + 0.035 * i)} alpha_mode="Blend" unlit emissive={glow("#ff5a2a", 0.5 * pulse)} />
        </Mesh3d>
      ))}
      <Mesh3d shadow={false} transform={at(...pt)}>
        <Sphere radius={r} />
        <StandardMaterial base_color="#d9442a" unlit emissive={glow("#e8502a", 3.2 * pulse)} />
      </Mesh3d>
    </>
  );
}

/** An eclipse: a black disc with a bright corona in the sky. */
function Eclipse({ c, p, cam }: { c: any; p: number; cam: V3 }) {
  const q = cueQ(c, p);
  const vis = smooth(0, 0.2, q) * (1 - smooth(0.8, 1, q));
  if (vis < 0.01) return null;
  const pt = skyPoint(cam, c.az, c.el * D2R, 60);
  const away: V3 = [pt[0] * 2 - cam[0], pt[1] * 2 - cam[1], pt[2] * 2 - cam[2]];
  const r = 7.5 * vis;
  return (
    <Entity transform={Transform.fromXyz(...pt).lookingAt(away)}>
      <Mesh3d shadow={false} transform={at(0, 0, 0.1)}>
        <Sphere radius={r} />
        <StandardMaterial base_color="#050507" unlit emissive={glow("#050507", 1)} />
      </Mesh3d>
      <Mesh3d shadow={false}>
        <Torus minor_radius={r * 0.09} major_radius={r * 1.02} />
        <StandardMaterial base_color="#ffe2a8" unlit emissive={glow("#ffd890", 5 * vis)} />
      </Mesh3d>
    </Entity>
  );
}

/** Where a creature is, as it crosses: a straight walk or flight along its path. */
function creatureAt(c: any, q: number, f: number): { x: number; y: number; z: number; yaw: number; size: number } {
  const it = c.items[0];
  const dir = it.rotY > 0 ? 1 : -1;
  const x = it.pos[0] + dir * 18 * q;
  const fly = c.what === "butterfly" || c.what === "bird";
  const y = fly ? 3 + Math.sin(q * 9 + f * 0.02) * 0.9 + (c.what === "bird" ? 3 : 0) : 0;
  const z = it.pos[2] + (fly ? Math.sin(q * 6) * 1.5 : Math.sin(q * 7) * 0.8);
  return { x, y, z, yaw: it.rotY, size: c.what === "crab" ? 2.4 : c.what === "butterfly" ? 2.4 : 2.6 };
}

/** A creature crossing the view (procedural: crab, butterfly, bird). */
function Creature({ c, p, f }: { c: any; p: number; f: number }) {
  const q = cueQ(c, p);
  const vis = smooth(0, 0.08, q) * (1 - smooth(0.92, 1, q));
  if (vis < 0.01 || p < c.p0 - 0.01 || p > c.p1 + 0.01) return null;
  const cr = creatureAt(c, q, f);
  const gait = Math.sin(f * 0.45);
  if (c.what === "butterfly" || c.what === "bird") {
    const flap = 0.55 + Math.sin(f * (c.what === "bird" ? 0.35 : 0.6)) * (c.what === "bird" ? 0.6 : 0.8); // wings held up in a V so they show from the side
    const col = c.what === "bird" ? "#2a2a33" : "#f4f1e8";
    const w = cr.size * vis;
    return (
      <Entity transform={at(cr.x, cr.y, cr.z, rot(0, cr.yaw))}>
        <Mesh3d shadow={false}>
          <Capsule3d radius={0.06 * w} half_length={0.3 * w} />
          <StandardMaterial base_color="#3a3228" />
        </Mesh3d>
        {[-1, 1].map((sd) => (
          <Entity key={sd} transform={at(0, 0, 0, rot(0, 0, sd * flap))}>
            <Mesh3d shadow={false} transform={at(sd * 0.55 * w, 0, 0.05 * w)}>
              <Cuboid half_size={[0.55 * w, 0.012, 0.38 * w]} />
              <StandardMaterial base_color={col} perceptual_roughness={0.6} unlit />
            </Mesh3d>
          </Entity>
        ))}
      </Entity>
    );
  }
  // a crab: a domed red shell raised on bent legs, stalked eyes, and two raised pincers
  const s = cr.size * vis;
  return (
    <Entity transform={at(cr.x, 0.62 * s, cr.z, rot(0, cr.yaw + Math.PI / 2))}>
      <Mesh3d shadow={false} transform={at(0, 0, 0).withScale([1.5, 0.6, 1])}>
        <Sphere radius={0.45 * s} />
        <StandardMaterial base_color="#9a3420" perceptual_roughness={0.45} />
      </Mesh3d>
      {[-1, 1].map((sd) => (
        <Entity key={sd} transform={at(0, 0, 0)}>
          {/* eye stalk with an eye on top */}
          <Mesh3d shadow={false} transform={at(sd * 0.2 * s, 0.34 * s, 0.4 * s)}>
            <Capsule3d radius={0.025 * s} half_length={0.09 * s} />
            <StandardMaterial base_color="#c9bba0" />
          </Mesh3d>
          <Mesh3d shadow={false} transform={at(sd * 0.2 * s, 0.47 * s, 0.4 * s)}>
            <Sphere radius={0.06 * s} />
            <StandardMaterial base_color="#161210" perceptual_roughness={0.2} />
          </Mesh3d>
          {/* arm up to a pincer: two jaws */}
          <Mesh3d shadow={false} transform={at(sd * 0.82 * s, 0.1 * s, 0.38 * s, rot(0.5, 0, sd * -0.7))}>
            <Capsule3d radius={0.05 * s} half_length={0.3 * s} />
            <StandardMaterial base_color="#a53a22" />
          </Mesh3d>
          <Mesh3d shadow={false} transform={at(sd * 1.0 * s, 0.38 * s + Math.max(0, gait) * 0.06 * s, 0.7 * s).withScale([0.8, 0.5, 1.5])}>
            <Sphere radius={0.2 * s} />
            <StandardMaterial base_color="#b8422a" perceptual_roughness={0.4} />
          </Mesh3d>
          <Mesh3d shadow={false} transform={at(sd * 1.0 * s, 0.38 * s + Math.max(0, gait) * 0.06 * s, 0.98 * s).withScale([0.4, 0.28, 1.0])}>
            <Cone radius={0.12 * s} height={0.4 * s} />
            <StandardMaterial base_color="#b8422a" perceptual_roughness={0.4} />
          </Mesh3d>
          {/* four bent walking legs */}
          {[0, 1, 2, 3].map((i) => (
            <Entity key={i} transform={at(sd * 0.55 * s, -0.05 * s, (-0.4 + i * 0.27) * s + Math.sin(f * 0.45 + i * 1.7 + (sd > 0 ? 0 : 3)) * 0.06 * s)}>
              <Mesh3d shadow={false} transform={at(sd * 0.22 * s, -0.1 * s, 0, rot(0, 0, sd * -0.9))}>
                <Capsule3d radius={0.032 * s} half_length={0.26 * s} />
                <StandardMaterial base_color="#7a2a1a" />
              </Mesh3d>
              <Mesh3d shadow={false} transform={at(sd * 0.45 * s, -0.38 * s, 0, rot(0, 0, sd * 0.4))}>
                <Capsule3d radius={0.026 * s} half_length={0.2 * s} />
                <StandardMaterial base_color="#6a2216" />
              </Mesh3d>
            </Entity>
          ))}
        </Entity>
      ))}
    </Entity>
  );
}

/** Models that spring up (and fade away like vapour) across the view. */
function Grow({ c, p, f }: { c: any; p: number; f: number }) {
  const q = cueQ(c, p);
  if (p < c.p0 - 0.02 || p > c.p1 + 0.02) return null;
  const how: string = c.how || "sprout";
  return (
    <>
      {(c.items as any[]).map((it, i) => {
        const up = how.includes("melt") ? 1 : clamp(backOut(clamp((q - it.d) / 0.28)), 0, 1.15);
        const down = how.includes("rise") ? 0 : smooth(0.55 + it.d * 0.4, 0.9 + it.d * 0.1, q);
        const sc = it.scale * up * (1 - down);
        if (sc < 0.004) return null;
        if (it.tower) {
          // a dream tower: glassy blue-grey, lit windows, rising out of the ground
          const g = up * (1 - down);
          const h = it.tower.h * g;
          if (h < 0.05) return null;
          return (
            <Entity key={i} transform={at(it.pos[0], it.pos[1], it.pos[2], rot(0, it.rotY))}>
              <Mesh3d shadow={false} transform={at(0, h / 2, 0)}>
                <Cuboid half_size={[it.tower.w / 2, h / 2, it.tower.w / 2]} />
                <StandardMaterial base_color={Srgba.hex("#9fb4d6").with_alpha(0.62)} alpha_mode="Blend" perceptual_roughness={0.2} metallic={0.3} />
              </Mesh3d>
              {Array.from({ length: Math.min(9, Math.floor(h / 2.2)) }, (_, r) => (
                <Mesh3d key={r} shadow={false} transform={at(0, 1.6 + r * 2.2, it.tower.w / 2 + 0.02)}>
                  <Cuboid half_size={[it.tower.w * 0.38, 0.35, 0.02]} />
                  <StandardMaterial base_color="#ffe6a8" unlit emissive={glow("#ffd37a", 1.4 + 0.6 * Math.sin(f * 0.2 + r + i))} />
                </Mesh3d>
              ))}
              <Mesh3d shadow={false} transform={at(0, h + 0.5 * g, 0)}>
                <Cone radius={it.tower.w * 0.45} height={Math.max(0.1, 2.2 * g)} />
                <StandardMaterial base_color="#c9d6ee" perceptual_roughness={0.3} />
              </Mesh3d>
            </Entity>
          );
        }
        return <Model key={i} src={media(it.file)} position={[it.pos[0], it.pos[1] - down * 3, it.pos[2]]} rotation={[0, it.rotY + Math.sin(f * 0.05 + i) * 0.04 + down * 1.5, 0]} scale={sc} />;
      })}
    </>
  );
}

/** Speed lines rushing past the camera. */
function Streaks({ c, p, cam, look, f }: { c: any; p: number; cam: V3; look: V3; f: number }) {
  const q = cueQ(c, p);
  const vis = smooth(0, 0.08, q) * (1 - smooth(0.92, 1, q));
  if (vis < 0.01) return null;
  const k = 0.012 * (1 + c.amount * 2.5);
  return (
    <Entity transform={Transform.fromXyz(...cam).lookingAt(look)}>
      {Array.from({ length: 36 }, (_, i) => {
        const depth = 3 + ((rr(i, 5) + f * k * (0.6 + rr(i, 3) * 1.2)) % 1) * 55;
        const len = 5 + rr(i, 4) * 14;
        return (
          <Mesh3d key={i} shadow={false} transform={Transform.fromXyz((rr(i, 1) - 0.5) * 16, (rr(i, 2) - 0.5) * 9, -depth)}>
            <Cuboid half_size={[0.025, 0.025, len / 2]} />
            <StandardMaterial base_color="#dfeaff" unlit emissive={glow("#cfe0ff", 1.6 * vis)} />
          </Mesh3d>
        );
      })}
    </Entity>
  );
}

// ---- looks: the whole frame's style (R.style), picked per book from its text and overridable by the reader (src/lib/style.ts)
const STYLE: string = (R.style as string) ?? "cinematic";
const PAINTED = ["storybook", "cartoon", "dream", "pixel"].includes(STYLE);
/** the flat sky the painted looks fill behind everything: from the world's starting hour and weather */
function skyColours(): [string, string] {
  if (R.weather === "overcast" || R.weather === "rain" || R.weather === "storm" || R.weather === "fog" || R.weather === "snow") return ["#8d95a3", "#d4d8de"];
  const e = R.sun.startElev;
  if (e < 0) return ["#0b1030", "#2b3366"];
  if (e < 12) return ["#6e5f95", "#f0a574"];
  if (e < 40) return ["#7fb0dc", "#f0e2c8"];
  return ["#6fa6d8", "#dfe6ee"];
}

function Scene() {
  const f = useCurrentFrame();
  const live = R.live === true;
  const world = useGameState(WORLD0, stepWorld);
  const p = live ? world.t : clamp(f / (N - 1));
  const { elev, rising } = sunAt(p);

  // directed shots: the host names the shot and how far through it we are; baked frames derive both from p
  const shots = (R.shots ?? []) as any[];
  let shotIdx = -1;
  let shotP = 0;
  if (shots.length) {
    if (live && world.shot >= 0) {
      shotIdx = Math.min(world.shot, shots.length - 1);
      shotP = world.shotP >= 0 ? world.shotP : 0;
    } else {
      shotIdx = shots.findIndex((x) => p >= x.p0 && p < x.p1);
      if (shotIdx < 0) shotIdx = p >= 1 ? shots.length - 1 : 0;
      shotP = clamp((p - shots[shotIdx].p0) / Math.max(1e-6, shots[shotIdx].p1 - shots[shotIdx].p0));
    }
  }
  const dirShot = shotIdx >= 0 && !(live && world.control) ? shots[shotIdx] : null;
  const sky = skyFor(elev, rising);
  const up = Math.max(0, Math.sin(clamp(elev, 0, 90) * D2R));
  const night = elev < -2;
  const e = night ? 38 : Math.max(elev, 4);
  const az = R.sun.azimuth;
  const sunPos: [number, number, number] = [Math.sin(az) * Math.cos(e * D2R) * 30, Math.sin(e * D2R) * 30, Math.cos(az) * Math.cos(e * D2R) * 30];
  const lowSun = 1 - smooth(4, 26, elev);
  const sunColor = night ? "#7f9cff" : lowSun > 0.4 ? "#ff9a5c" : R.sun.color;
  const illum = (night ? 1800 : 500 + 12500 * Math.pow(up, 0.65)) * R.sun.strength;

  const c = dirShot ?? R.camera;
  const ct = smooth(0, 1, dirShot ? shotP : p);
  const shake = R.sun.cycles > 0 ? 0.012 + 0.05 * smooth(0.2, 0.8, p) : 0.006;
  // the orbit's centre slides sideways (along the camera's right) with A/D
  const panX = Math.cos(world.yaw) * world.pan;
  const panZ = -Math.sin(world.yaw) * world.pan;
  const orbit: [number, number, number] = [
    LOOK[0] + panX + world.dist * Math.sin(world.yaw) * Math.cos(world.pitch),
    LOOK[1] + world.dist * Math.sin(world.pitch),
    LOOK[2] + panZ + world.dist * Math.cos(world.yaw) * Math.cos(world.pitch),
  ];
  if (live && R.room) {
    // never leave the room: clamp the orbit camera inside the walls and below the ceiling
    orbit[0] = clamp(orbit[0], -R.room.w / 2 + 0.4, R.room.w / 2 - 0.4);
    orbit[1] = clamp(orbit[1], 0.35, R.room.h - 0.35);
    orbit[2] = clamp(orbit[2], -R.room.d / 2 + 0.4, R.room.d / 2 - 0.4);
  }
  const cam: [number, number, number] = live && world.control
    ? orbit
    : live
    ? [world.sm.cam[0] + Math.sin(f * 1.7) * shake, world.sm.cam[1] + Math.cos(f * 1.3) * shake, world.sm.cam[2]]
    : [
        mix(c.from[0], c.to[0], ct) + Math.sin(f * 1.7) * shake,
        mix(c.from[1], c.to[1], ct) + Math.cos(f * 1.3) * shake,
        mix(c.from[2], c.to[2], ct),
      ];
  const look: [number, number, number] = live && world.control
    ? [
        R.room ? clamp(LOOK[0] + panX, -R.room.w / 2 + 0.4, R.room.w / 2 - 0.4) : LOOK[0] + panX,
        LOOK[1],
        R.room ? clamp(LOOK[2] + panZ, -R.room.d / 2 + 0.4, R.room.d / 2 - 0.4) : LOOK[2] + panZ,
      ]
    : live
    ? [world.sm.look[0], world.sm.look[1], world.sm.look[2]]
    : [mix(c.lookFrom[0], c.lookTo[0], ct), mix(c.lookFrom[1], c.lookTo[1], ct), mix(c.lookFrom[2], c.lookTo[2], ct)];
  const fovDeg = live ? world.sm.fov : c.fov;
  const heavyWx = R.weather === "storm" || R.weather === "rain";

  // ---- stage cues acting on the camera and the light (the free camera, when the viewer has taken it, is left alone)
  const cues: any[] = (R.stage ?? []) as any[];
  const on = (k: string) => cues.filter((c) => c.k === k && p >= c.p0 - 0.01 && p <= c.p1 + 0.01);
  const takenOver = live && world.control;
  let camS: V3 = [cam[0], cam[1], cam[2]];
  let lookS: V3 = [look[0], look[1], look[2]];
  let fovS = fovDeg;
  let upS: V3 = [0, 1, 0];
  let flashM = 1;
  let shakeS = 0;
  const moonCue = cues.find((c) => c.k === "moon");
  if (!takenOver) {
    // Frame what the story is doing: while a cue plays the camera pulls back (and widens) until the event is in the picture,
    // and for the sky it tilts up to find it. A tight close-up would miss it.
    const ramp = (c: any) => { const q = cueQ(c, p); return smooth(0, 0.18, q) * (1 - smooth(0.82, 1, q)); };
    let wide = 0;
    let skyW = 0;
    for (const c of on("grow")) wide = Math.max(wide, ramp(c));
    for (const c of on("streak")) wide = Math.max(wide, 0.7 * ramp(c));
    for (const c of on("flash")) wide = Math.max(wide, 0.7 * ramp(c));
    for (const c of on("quake")) wide = Math.max(wide, 0.8 * ramp(c));
    for (const c of on("sun")) skyW = Math.max(skyW, ramp(c));
    for (const c of on("dim")) if ((c.how ?? "").includes("eclipse")) skyW = Math.max(skyW, ramp(c));
    for (const c of on("creature")) wide = Math.max(wide, ramp(c));
    for (const c of on("moon")) skyW = Math.max(skyW, ramp(c));
    // a creature crossing wins over a sky event that is still running: it is the newest thing to look at
    for (const c of on("creature")) skyW *= 1 - 0.9 * ramp(c);
    if (wide > 0.001 || skyW > 0.001) {
      const w = Math.max(wide, 0.6 * skyW);
      const back = vsub(camS, lookS);
      const dNow = Math.hypot(back[0], back[1], back[2]) || 1;
      const want = 12; // metres from the subject: far enough for trees and towers to show around it
      const dNew = Math.max(dNow, want);
      // keep a gentle angle (a little above the horizon): a steep or overhead shot would pull back into a view of the ground
      const hz = Math.hypot(back[0], back[2]);
      const elev = Math.min(0.42, Math.max(-0.08, Math.atan2(back[1], Math.max(hz, 1e-3))));
      const ux = hz > 1e-3 ? back[0] / hz : 0;
      const uz = hz > 1e-3 ? back[2] / hz : 1;
      const tgt: V3 = [lookS[0] + ux * Math.cos(elev) * dNew, lookS[1] + Math.sin(elev) * dNew + 0.6, lookS[2] + uz * Math.cos(elev) * dNew];
      camS = [mix(camS[0], tgt[0], w), mix(camS[1], tgt[1], w) + 1.2 * w, mix(camS[2], tgt[2], w)];
      fovS = fovS + 9 * w;
    }
    for (const c of on("creature")) {
      // a reveal shot: the camera low and well back, looking straight at it as it crosses
      const cr = creatureAt(c, cueQ(c, p), f);
      const w = ramp(c);
      const camT: V3 = [cr.x * 0.35, 1.4 + cr.y * 0.4, cr.z + 9.5];
      camS = [mix(camS[0], camT[0], 0.9 * w), mix(camS[1], camT[1], 0.9 * w), mix(camS[2], camT[2], 0.9 * w)];
      lookS = [mix(lookS[0], cr.x, 0.95 * w), mix(lookS[1], cr.y + 0.7, 0.95 * w), mix(lookS[2], cr.z, 0.95 * w)];
    }
    if (skyW > 0.001) {
      const ecl = on("dim").find((c) => (c.how ?? "").includes("eclipse"));
      const tc = moonCue && on("moon").length ? moonCue : ecl ?? on("sun")[0];
      const target: V3 = tc.k === "moon" ? moonAt(tc, cueQ(tc, p), camS) : tc.k === "dim" ? skyPoint(camS, tc.az, tc.el * D2R, 60) : isRedSun(tc) ? skyPoint(camS, tc.az, tc.el * D2R, 70) : skyPoint(camS, tc.az + cueQ(tc, p) * 2.6, (tc.el + 62 * Math.sin(Math.PI * cueQ(tc, p))) * D2R, 60);
      const k = 0.85 * skyW;
      lookS = [mix(lookS[0], target[0], k), mix(lookS[1], target[1], k), mix(lookS[2], target[2], k)];
    }
    for (const c of on("cam")) {
      const q = cueQ(c, p);
      const b = bell(q);
      const a = c.amount ?? 0.6;
      const how: string = c.how || "";
      if (how.includes("look_up") || how.includes("sky") || how.includes("moon")) {
        const target: V3 = moonCue ? moonAt(moonCue, cueQ(moonCue, p), camS) : skyPoint(camS, Math.atan2(lookS[0] - camS[0], -(lookS[2] - camS[2])), 0.55);
        const w = smooth(0, 0.22, q) * (1 - smooth(0.8, 1, q));
        lookS = [mix(lookS[0], target[0], w), mix(lookS[1], target[1], w), mix(lookS[2], target[2], w)];
        camS = [camS[0], mix(camS[1], Math.max(0.5, camS[1] - 0.6), w), camS[2]]; // a little lower, to look up at it
      }
      if (how.includes("roll") || how.includes("spin")) {
        const ang = how.includes("spin") ? q * Math.PI * 2 * a : Math.sin(q * Math.PI * 2) * 0.6 * a;
        const fwd = vnorm(vsub(lookS, camS));
        const u: V3 = [0, 1, 0];
        const side = vcross(fwd, u);
        upS = [u[0] * Math.cos(ang) + side[0] * Math.sin(ang), u[1] * Math.cos(ang) + side[1] * Math.sin(ang), u[2] * Math.cos(ang) + side[2] * Math.sin(ang)];
      }
      if (how.includes("crane")) {
        camS = [camS[0], camS[1] + b * 9 * a, camS[2]];
        lookS = [lookS[0], lookS[1] + b * 2 * a, lookS[2]];
      }
      if (how.includes("punch") || how.includes("zoom")) {
        const fwd = vnorm(vsub(lookS, camS));
        camS = [camS[0] - fwd[0] * b * 7 * a, camS[1] - fwd[1] * b * 7 * a, camS[2] - fwd[2] * b * 7 * a];
        fovS = fovS * (1 - 0.42 * b * a);
      }
    }
    // the judge's request: a shot that was too tight is pulled back
    if (widenS > 0.01) {
      const back = vsub(camS, lookS);
      const k = 1 + 1.1 * widenS;
      camS = [lookS[0] + back[0] * k, lookS[1] + back[1] * k + 0.4 * widenS, lookS[2] + back[2] * k];
      fovS += 7 * widenS;
    }
    // the camera never sits inside or against a placed thing: unless it is looking at that thing, keep clear of it
    for (const a of R.assets as any[]) {
      const dx = camS[0] - a.pos[0];
      const dz = camS[2] - a.pos[2];
      const d = Math.hypot(dx, dz);
      const focused = Math.hypot(lookS[0] - a.pos[0], lookS[2] - a.pos[2]) < 1.6;
      const need = focused ? 1.3 : 2.2;
      if (d < need && camS[1] < 3.5) {
        const ux = d > 1e-3 ? dx / d : 0;
        const uz = d > 1e-3 ? dz / d : 1;
        camS = [a.pos[0] + ux * need, camS[1], a.pos[2] + uz * need];
      }
    }
    for (const c of on("quake")) shakeS += 0.22 * (c.amount ?? 0.6) * bell(cueQ(c, p));
  }
  let dimOv = 0; // a dark veil over the picture: the painted looks' flat sky ignores the lights, so the dimming is drawn on top
  let veil = "#04050c";
  for (const c of on("sun")) {
    if (!isRedSun(c)) continue;
    // a huge red sun means a dying, reddened day: the whole picture sinks into a deep red dusk
    const q = cueQ(c, p);
    const hold = smooth(0, 0.2, q) * (1 - smooth(0.8, 1, q));
    if (hold * 0.55 > dimOv) { dimOv = hold * 0.55; veil = "#3a0a06"; }
  }
  for (const c of on("moon")) {
    // the moon wants a night sky around it, not a flat grey one
    const q = cueQ(c, p);
    const hold = smooth(0, 0.2, q) * (1 - smooth(0.8, 1, q));
    if (hold * 0.62 > dimOv) { dimOv = hold * 0.62; veil = "#070a1c"; }
  }
  for (const c of on("dim")) {
    const q = cueQ(c, p);
    const hold = smooth(0, 0.25, q) * (1 - smooth(0.75, 1, q));
    const eclipse = (c.how ?? "").includes("eclipse");
    flashM *= 1 - 0.88 * (c.amount ?? 0.7) * hold;
    dimOv = Math.max(dimOv, (eclipse ? 0.6 : 0.78) * (c.amount ?? 0.7) * hold);
  }
  for (const c of on("flash")) {
    const b = bell(cueQ(c, p));
    if ((c.how || "").includes("light")) {
      const bolt = Math.max(0, Math.sin(f * 0.93) * Math.sin(f * 0.41 + 1.3) - 0.55) * 2.2;
      flashM *= 1 + 6 * bolt * b * (c.amount ?? 0.6);
    } else {
      flashM *= 1 + (c.amount ?? 0.6) * b * (Math.sin(f * 0.55) > 0 ? 1.7 : -0.7);
    }
  }
  if (shakeS > 0) camS = [camS[0] + Math.sin(f * 2.3) * shakeS, camS[1] + Math.cos(f * 2.9) * shakeS, camS[2] + Math.sin(f * 1.9) * shakeS];

  return (
    <AbsoluteFill style={{ background: "#05070b" }}>
      <Camera3d transform={Transform.fromXyz(...camS).lookingAt(lookS, upS)} projection={{ Perspective: { fov: (fovS * Math.PI) / 180 } }}>
        <DepthOfField focal_distance={Math.hypot(camS[0] - lookS[0], camS[2] - lookS[2])} aperture_f_stops={c.fstop} />
      </Camera3d>
      <Environment src={media(sky.file)} intensity={R.interior ? 0.35 : R.sky.intensity} rotation={R.sky.rotation} background={!R.interior} />
      <AmbientLight brightness={(R.interior ? 220 : 30) * (1 + (flashM - 1) * 0.6)} />
      <DirectionalLight transform={Transform.fromXyz(...sunPos).lookingAt([0, 0, 0])} illuminance={(R.interior ? illum * 0.25 : illum) * flashM} color={sunColor} shadow_maps_enabled />
      {PAINTED ? <Shadows distance={36} firstCascade={36} cascades={1} mapSize={4096} /> : <Shadows distance={40} firstCascade={10} cascades={2} mapSize={2048} bias={0.03} normalBias={2} />}
      {R.fog.density > 0 && STYLE !== "pixel" ? <Fog color={R.fog.color} density={STYLE === "cinematic" ? R.fog.density : R.fog.density * 0.5} /> : null}
      {STYLE === "cinematic" ? (
        <>
          <Bloom intensity={0.45} threshold={1.5} />
          <ToneMapping mode="aces" exposure={R.exposure} />
          <Grade vignette={0.32} />
        </>
      ) : null}
      {STYLE === "storybook" ? (
        <>
          <Look mode="paint" bands={3} shadow="#a9afc6" mid="#d8b6a8" grain={0.3} rag={2} stroke={0.45} wash={0.55} saturate={1.08} calm="#97a366" foliage={0.6} cloudShadows={0.3} sky={skyColours()} />
          <Grade temperature={0.05} vignette={0.28} />
        </>
      ) : null}
      {STYLE === "cartoon" ? (
        <>
          <Look mode="cartoon" outline="none" sky={skyColours()} wash={0.7} saturate={1.2} />
          <Outline color="#2b1d14" width={5} depth={0.05} far={42} />
          <Grade saturation={1.1} />
        </>
      ) : null}
      {STYLE === "dream" ? (
        <>
          <Look mode="paint" bands={4} shadow="#cbc8e4" mid="#efdbe8" grain={0.5} rag={3.6} stroke={0.7} wash={0.85} saturate={0.95} cloudShadows={0.35} sky={skyColours()} />
          <Bloom intensity={0.9} threshold={0.85} />
          <Grade temperature={-0.02} saturation={0.92} vignette={0.2} />
        </>
      ) : null}
      {STYLE === "noir" ? (
        <>
          <Look mode="ink" pixelSize={3} ink="#07080c" paper="#e9e5d9" line={0.12} threshold={0.45} band={0.5} />
          <Grade vignette={0.5} />
        </>
      ) : null}
      {STYLE === "pixel" ? (
        <>
          <Look mode="paint" bands={3} shadow="#9aa0b8" mid="#cdb09f" grain={0} rag={0} texel={0.045} texelJitter={0.06} wash={0.9} saturate={1.15} calm="#97a366" sky={skyColours()} />
          <Grade vignette={0.2} />
        </>
      ) : null}

      {R.ground ? (
        <Mesh3d>
          <Plane3d normal={[0, 1, 0]} half_size={[70, 70]} />
          <StandardMaterial
            base_color_texture={tex(R.ground.id, "diff.jpg")}
            normal_map_texture={tex(R.ground.id, "nor.jpg")}
            metallic_roughness_texture={tex(R.ground.id, "arm.jpg")}
            occlusion_texture={tex(R.ground.id, "arm.jpg")}
            metallic={1}
            perceptual_roughness={1}
            uv_transform={Affine2.fromScale([140 / R.ground.tile, 140 / R.ground.tile])}
          />
        </Mesh3d>
      ) : null}
      {R.room ? <Room /> : null}

      {R.assets.map((a: any, i: number) => (
        <Model key={i} src={media(a.file)} position={a.pos} rotation={[0, a.rotY, 0]} scale={a.scale} />
      ))}
      {R.hero.kind === "time_machine" ? <Machine p={p} f={f} /> : null}
      {(R.figures as any[]).filter((x) => !x.onMachine).map((x, i) => <Figure key={i} fig={x} f={f} p={p} />)}
      {R.hero.sphinx ? <Sphinx /> : null}
      {heavyWx ? <Rain f={f} heavy={R.weather === "storm"} /> : null}

      {cues.map((c, i) => {
        if (c.k === "moon") return <Moon key={i} c={c} p={p} cam={camS} />;
        if (c.k === "sun") return isRedSun(c) ? <RedSun key={i} c={c} p={p} cam={camS} f={f} /> : <SunStreak key={i} c={c} p={p} cam={camS} />;
        if (c.k === "creature") return <Creature key={i} c={c} p={p} f={f} />;
        if (c.k === "dim" && (c.how ?? "").includes("eclipse")) return <Eclipse key={i} c={c} p={p} cam={camS} />;
        if (c.k === "grow") return <Grow key={i} c={c} p={p} f={f} />;
        if (c.k === "streak") return <Streaks key={i} c={c} p={p} cam={camS} look={lookS} f={f} />;
        return null;
      })}

      {dimOv > 0.004 ? <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, background: veil, opacity: dimOv }} /> : null}
      {live && world.fade > 0.002 ? <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, background: "#000", opacity: world.fade }} /> : null}

      {R.lights.map((l: any, i: number) => (
        <PointLight key={i} transform={Transform.fromXyz(...(l.pos as [number, number, number]))} intensity={l.intensity * (0.92 + 0.08 * Math.sin(f * 0.37 + i))} color={l.color} range={14} />
      ))}
    </AbsoluteFill>
  );
}

registerRoot(() => <Composition id="scene" component={Scene} width={W} height={H} fps={R.fps} durationInFrames={N} />);
