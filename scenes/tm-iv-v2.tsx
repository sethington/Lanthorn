import { AbsoluteFill, Composition, registerRoot, useCurrentFrame } from "raea";
import { Bloom, DepthOfField, Grade, MotionBlur, Shadows, Sphere, Torus, ToneMapping, Entity } from "raea/3d";
import { LinearRgba, Srgba } from "raea/color";
import { StandardMaterial } from "raea/pbr";
import { Cone, Cuboid, Cylinder, Mesh3d } from "raea/mesh";
import { AmbientLight, DirectionalLight, PointLight } from "raea/light";
import { Quat, Transform } from "raea/transform";
import { Camera3d } from "raea/camera";

// Time Machine ch. IV, v2. Pure function of p (0..1 across the text span).
const N = 360;
const W = 720;
const H = 900;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
type RGB = [number, number, number];
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const toHex = (c: RGB) => "#" + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
const glow = (hex: string, k: number) => LinearRgba.from(Srgba.hex(hex)).mul(k);

const NIGHT: RGB = [20, 30, 74];
const DAWN: RGB = [236, 140, 96];
const DAY: RGB = [112, 168, 232];
const TWI: RGB = [78, 92, 168];

const hills = [
  // [x, z, rx, ry, rz, layer]
  [-14, -22, 16, 3.2, 8, 0], [10, -24, 18, 4.2, 9, 0], [26, -20, 12, 3, 7, 0], [-30, -18, 14, 3, 7, 0],
  [-6, -14, 11, 1.7, 6, 1], [12, -13, 10, 1.9, 6, 1], [-22, -12, 9, 1.6, 5, 1],
  [-3, -8, 8, 0.8, 4, 2], [9, -7, 7, 0.9, 4, 2], [-12, -6, 6, 0.7, 3.5, 2],
] as const;
const trees = [
  [-4.8, -3], [-3.2, -5.2], [4.1, -4.1], [5.6, -2.2], [-6.2, 0.6], [2.4, -6.6], [-1.4, -7.4], [6.8, -6], [-7.4, -5],
] as const;
const towers = [
  [-8, -13, 1.6, 9], [8.8, -15, 1.9, 12], [0.5, -19, 2.4, 16], [-4.6, -17, 1.4, 7], [4.6, -17, 1.6, 10], [13, -18, 2, 13],
] as const;

function Scene() {
  const f = useCurrentFrame();
  const p = clamp(f / (N - 1));

  // time: slow, then accelerating; day/night flicker resolves into a steady twilight
  const days = 44 * Math.pow(p, 2.7);
  const ang = days * Math.PI * 2;
  const blur = smooth(0.52, 0.74, p);
  const sunH = Math.sin(ang); // -1..1 elevation
  const day = mix(smooth(-0.15, 0.35, sunH), 0.42, blur);
  const dusk = mix(1 - smooth(0.05, 0.5, Math.abs(sunH)), 0.55, blur);
  const night = 1 - day;

  const skyRGB = mixRGB(mixRGB(NIGHT, DAY, day), mixRGB(DAWN, TWI, blur), dusk * 0.55 * (1 - blur * 0.2));
  const sky = toHex(mixRGB(skyRGB, TWI, blur * 0.7));
  const haze = mixRGB(skyRGB, [200, 210, 230], 0.35);

  // sun and moon on a high arc behind the scene; when time blurs they smear into arches
  const R = 30;
  const sunPos: [number, number, number] = [Math.cos(ang) * R, Math.sin(ang) * 20 - 2, -42];
  const moonPos: [number, number, number] = [-Math.cos(ang) * R, -Math.sin(ang) * 20 - 2, -42];
  const sunWarm = toHex(mixRGB([255, 236, 200], [255, 130, 60], 1 - smooth(0.0, 0.5, sunH)));
  const lightColor = toHex(mixRGB([140, 165, 255], mixRGB([255, 236, 200], [255, 140, 70], 1 - smooth(0.0, 0.5, sunH)), day));

  // snow flashes through the middle of the run
  const snow = clamp(Math.sin(days * 0.9 * Math.PI) * 0.7) * (1 - blur) * smooth(0.18, 0.3, p);

  // camera: push in, drift, and a handheld shake that builds with speed
  const shake = 0.012 + 0.05 * smooth(0.25, 0.8, p);
  const cx = Math.sin(p * 2.4) * 1.6 + Math.sin(f * 1.7) * shake;
  const cy = mix(2.1, 2.9, smooth(0, 1, p)) + Math.cos(f * 1.3) * shake;
  const cz = mix(9.5, 6.4, smooth(0, 0.8, p));
  const fov = mix(46, 62, smooth(0.3, 0.9, p));
  const dist = Math.hypot(cx, cz);
  const fast = smooth(0.3, 0.55, p);

  const lab = 1 - smooth(0.08, 0.3, p);
  const rod = 0.6 + 5 * smooth(0.0, 0.6, p);

  return (
    <AbsoluteFill style={{ background: sky }}>
      <Camera3d transform={Transform.fromXyz(cx, cy, cz).lookingAt([0, 1.25 + Math.sin(f * 0.9) * shake * 0.5, 0])} projection={{ Perspective: { fov: (fov * Math.PI) / 180 } }}>
        <DepthOfField focal_distance={dist} aperture_f_stops={mix(2.4, 5.6, blur)} />
      </Camera3d>
      <Bloom intensity={1.15} threshold={0.85} />
      <ToneMapping mode="aces" exposure={0.3} />
      <Grade vignette={0.42} aberration={0.003} />
      <Shadows distance={34} firstCascade={10} cascades={2} mapSize={2048} />
      {fast > 0.01 ? <MotionBlur shutterAngle={0.2 + 0.8 * fast} samples={5} /> : null}

      <AmbientLight brightness={mix(90, 260, day)} color={toHex(mixRGB([70, 90, 170], [220, 230, 255], day))} />
      <DirectionalLight
        transform={Transform.fromXyz(sunPos[0] * 0.5, Math.max(4, sunPos[1] + 12), 14).lookingAt([0, 0, 0])}
        illuminance={mix(1800, 12000, day)}
        color={lightColor}
        shadow_maps_enabled
      />
      <PointLight transform={Transform.fromXyz(0, 1.7, 0.9)} intensity={mix(4000, 90000, smooth(0.05, 0.7, p))} color="#a8e8ff" range={14} />

      {/* sky dome */}
      <Mesh3d shadow={false} transform={Transform.IDENTITY.withScale([-1, 1, 1])}>
        <Sphere radius={70} />
        <StandardMaterial base_color={sky} unlit double_sided />
      </Mesh3d>

      {/* stars */}
      {Array.from({ length: 46 }, (_, i) => {
        const a = (i * 2.399) % (Math.PI * 2);
        const e = 0.25 + ((i * 0.137) % 0.7);
        const r = 64;
        return (
          <Mesh3d shadow={false} key={`s${i}`} transform={Transform.fromXyz(Math.cos(a) * r * 0.9, e * 46 + 4, -Math.abs(Math.sin(a)) * r * 0.9 - 6)}>
            <Sphere radius={0.22} />
            <StandardMaterial base_color="#ffffff" unlit emissive={glow("#dfe8ff", 6 * night * (1 - blur * 0.8))} />
          </Mesh3d>
        );
      })}

      {/* sun, moon: discs when sharp, arches when time blurs */}
      <Mesh3d shadow={false} transform={Transform.fromXyz(...sunPos)}>
        <Sphere radius={mix(1.8, 0.1, blur)} />
        <StandardMaterial base_color="#fff2cc" unlit emissive={glow(sunWarm, 14 * (1 - blur))} />
      </Mesh3d>
      <Mesh3d shadow={false} transform={Transform.fromXyz(...moonPos)}>
        <Sphere radius={mix(1.3, 0.1, blur)} />
        <StandardMaterial base_color="#e8eeff" unlit emissive={glow("#b8c8ff", 7 * (1 - blur))} />
      </Mesh3d>
      <Mesh3d shadow={false} transform={Transform.fromXyz(0, -2, -42).withRotation(Quat.fromEuler("XYZ", Math.PI / 2, 0, 0))}>
        <Torus major_radius={30} minor_radius={0.55} />
        <StandardMaterial base_color="#ffd9a0" unlit emissive={glow("#ffb868", 9 * blur)} />
      </Mesh3d>
      <Mesh3d shadow={false} transform={Transform.fromXyz(0, -2, -44).withRotation(Quat.fromEuler("XYZ", Math.PI / 2, 0, 0))}>
        <Torus major_radius={32} minor_radius={0.3} />
        <StandardMaterial base_color="#cfd8ff" unlit emissive={glow("#9db0ff", 3 * blur)} />
      </Mesh3d>

      {/* ground */}
      <Mesh3d transform={Transform.fromXyz(0, -0.2, -6)}>
        <Cylinder radius={60} half_height={0.2} />
        <StandardMaterial base_color={toHex(mixRGB(mixRGB([44, 78, 46], [110, 150, 80], day), [236, 240, 248], snow))} perceptual_roughness={0.95} />
      </Mesh3d>

      {/* hills, three layers fading into the haze */}
      {hills.map(([x, z, rx, ry, rz, layer], i) => {
        const base = mixRGB(mixRGB([34, 62, 44], [96, 140, 76], day), [236, 240, 248], snow);
        const far = mixRGB(base, haze, [0.62, 0.34, 0.1][layer]);
        return (
          <Mesh3d key={`h${i}`} transform={Transform.fromXyz(x, -0.2, z).withScale([rx, ry, rz])}>
            <Sphere radius={1} />
            <StandardMaterial base_color={toHex(far)} perceptual_roughness={1} />
          </Mesh3d>
        );
      })}

      {/* laboratory remnants dissolve */}
      {lab > 0.02 ? (
        <Entity transform={Transform.fromXyz(0, 0, -1.5).withScale([lab, lab, lab])}>
          <Mesh3d transform={Transform.fromXyz(-3.4, 0.55, -1)}>
            <Cuboid half_size={[1.3, 0.55, 0.65]} />
            <StandardMaterial base_color="#7a5636" perceptual_roughness={0.7} />
          </Mesh3d>
          <Mesh3d transform={Transform.fromXyz(3.6, 1.9, -2)}>
            <Cylinder radius={0.6} half_height={0.06} />
            <StandardMaterial base_color="#e6dfc9" emissive={glow("#ffd9a0", 0.5)} />
          </Mesh3d>
        </Entity>
      ) : null}

      {/* trees grow, spread, pass away */}
      {trees.map(([x, z], i) => {
        const life = clamp(Math.sin((days * 0.55 + i * 0.37) * Math.PI) * 1.4);
        const g = mix(0.04, 1, life);
        const leaf = toHex(mixRGB(mixRGB([36, 110, 52], [200, 130, 48], clamp(Math.sin(days * 1.7 + i) * 0.7 + 0.3)), [236, 240, 248], snow * 0.6));
        return (
          <Entity key={`t${i}`} transform={Transform.fromXyz(x, 0, z).withScale([g, g, g])}>
            <Mesh3d transform={Transform.fromXyz(0, 0.7, 0)}>
              <Cylinder radius={0.14} half_height={0.7} />
              <StandardMaterial base_color="#5a3f2a" />
            </Mesh3d>
            <Mesh3d transform={Transform.fromXyz(0, 1.7, 0)}>
              <Cone radius={1.1} height={1.7} />
              <StandardMaterial base_color={leaf} perceptual_roughness={0.9} />
            </Mesh3d>
            <Mesh3d transform={Transform.fromXyz(0, 2.6, 0)}>
              <Cone radius={0.8} height={1.4} />
              <StandardMaterial base_color={leaf} perceptual_roughness={0.9} />
            </Mesh3d>
          </Entity>
        );
      })}

      {/* towers rise "faint and fair", windows lit at night */}
      {towers.map(([x, z, w, h], i) => {
        const rise = clamp(Math.sin(clamp((p - 0.42 - i * 0.035) / 0.5) * Math.PI) * 1.5);
        const y = mix(-h - 1, 0, rise);
        const lit = 7 * night * rise;
        return (
          <Entity key={`w${i}`} transform={Transform.fromXyz(x, y, z)}>
            <Mesh3d transform={Transform.fromXyz(0, h / 2, 0)}>
              <Cuboid half_size={[w / 2, h / 2, w / 2]} />
              <StandardMaterial base_color={toHex(mixRGB([196, 206, 228], haze, 0.35))} perceptual_roughness={0.5} metallic={0.15} />
            </Mesh3d>
            {[0.22, 0.42, 0.62, 0.82].map((q, k) => (
              <Mesh3d key={k} transform={Transform.fromXyz(0, h * q, w / 2 + 0.02)}>
                <Cuboid half_size={[w * 0.36, 0.14, 0.02]} />
                <StandardMaterial base_color="#ffe3a8" unlit emissive={glow("#ffc766", lit)} />
              </Mesh3d>
            ))}
            <Mesh3d transform={Transform.fromXyz(0, h + 0.6, 0)}>
              <Cone radius={w * 0.32} height={1.4} />
              <StandardMaterial base_color="#e8eefc" emissive={glow("#9ec8ff", 0.4 * night)} />
            </Mesh3d>
          </Entity>
        );
      })}

      {/* the machine: brass and ivory, quartz rod glowing, dials spinning with the days */}
      <Entity transform={Transform.fromXyz(0, 0.45, 0).withRotation(Quat.fromEuler("XYZ", 0, Math.sin(f * 0.35) * 0.04 * p, Math.sin(f * 1.1) * 0.025 * p))}>
        <Mesh3d>
          <Cuboid half_size={[1.0, 0.13, 0.68]} />
          <StandardMaterial base_color="#c9a54a" metallic={0.9} perceptual_roughness={0.28} />
        </Mesh3d>
        {[-0.85, 0.85].map((x) => (
          <Mesh3d key={x} transform={Transform.fromXyz(x, 0.62, 0)}>
            <Cuboid half_size={[0.06, 0.6, 0.55]} />
            <StandardMaterial base_color="#f4eddc" perceptual_roughness={0.35} />
          </Mesh3d>
        ))}
        <Mesh3d transform={Transform.fromXyz(0, 0.35, 0.05)}>
          <Cuboid half_size={[0.28, 0.24, 0.28]} />
          <StandardMaterial base_color="#33241c" perceptual_roughness={0.5} />
        </Mesh3d>
        {/* quartz rod */}
        <Mesh3d transform={Transform.fromXyz(0.45, 0.7, 0.45)}>
          <Cylinder radius={0.05} half_height={0.5} />
          <StandardMaterial base_color="#e6fbff" unlit emissive={glow("#8ee8ff", rod)} />
        </Mesh3d>
        {/* dial: a disc with a hand sweeping at the rate of the days */}
        <Mesh3d transform={Transform.fromXyz(-0.45, 0.82, 0.58).withRotation(Quat.fromEuler("XYZ", Math.PI / 2, 0, 0))}>
          <Cylinder radius={0.26} half_height={0.02} />
          <StandardMaterial base_color="#efe6cf" />
        </Mesh3d>
        <Mesh3d transform={Transform.fromXyz(-0.45 + Math.cos(ang * 3) * 0.17, 0.82 + Math.sin(ang * 3) * 0.17, 0.61)}>
          <Cuboid half_size={[0.025, 0.025, 0.012]} />
          <StandardMaterial base_color="#ff5a3c" unlit emissive={glow("#ff5a3c", 4)} />
        </Mesh3d>
        {/* the Traveller */}
        <Mesh3d transform={Transform.fromXyz(0, 0.95, 0.05)}>
          <Cuboid half_size={[0.21, 0.32, 0.15]} />
          <StandardMaterial base_color="#4a3b2a" perceptual_roughness={0.8} />
        </Mesh3d>
        <Mesh3d transform={Transform.fromXyz(0, 1.5, 0.05)}>
          <Sphere radius={0.16} />
          <StandardMaterial base_color="#d8b99a" />
        </Mesh3d>
        <Mesh3d transform={Transform.fromXyz(0, 1.64, 0.05)}>
          <Cylinder radius={0.17} half_height={0.05} />
          <StandardMaterial base_color="#2a2118" />
        </Mesh3d>
      </Entity>
    </AbsoluteFill>
  );
}

registerRoot(() => <Composition id="tm-iv-v2" component={Scene} width={W} height={H} fps={30} durationInFrames={N} />);
