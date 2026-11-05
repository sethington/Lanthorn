import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame, useVideoConfig } from "raea";
import { Entity } from "raea/3d";
import { StandardMaterial } from "raea/pbr";
import { Cuboid, Cone, Cylinder, Mesh3d, Sphere } from "raea/mesh";
import { AmbientLight, DirectionalLight } from "raea/light";
import { Quat, Transform } from "raea/transform";
import { Camera3d } from "raea/camera";

// Time Machine ch. IV: the Traveller accelerates. Whole scene is a pure function of p (0..1 across the text span).
const N = 300;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
const lerpHex = (c1: [number, number, number], c2: [number, number, number], t: number) =>
  hex(mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t));

const trees = [
  [-4.5, -3], [-3, -5], [3.8, -4], [5.2, -2], [-5.5, 1], [2.2, -6.5], [-1.2, -7],
];
const towers = [
  [-6, -6, 0.9, 5], [6.4, -6.5, 1.1, 7], [0, -9, 1.4, 9], [-3.2, -8.5, 0.8, 4], [3.5, -9, 0.9, 6],
];

function Scene() {
  const f = useCurrentFrame();
  const p = clamp(f / (N - 1));

  // days elapsed: slow start, then accelerating; the flicker fades into a steady blur after 0.6
  const days = 70 * p * p * p;
  const ang = days * Math.PI * 2;
  const blur = clamp((p - 0.5) / 0.2); // 0 = sharp day/night, 1 = steady twilight
  const sunY = Math.sin(ang);
  const sunX = Math.cos(ang);
  const dayness = mix(clamp(sunY * 1.4 + 0.25), 0.45, blur);

  const sky = lerpHex([10, 14, 32], [150, 190, 230], dayness);
  const twilight = lerpHex([40, 60, 110], [70, 110, 190], 0.5);
  const bg = blur > 0 ? lerpHex(
    [parseInt(sky.slice(1, 3), 16), parseInt(sky.slice(3, 5), 16), parseInt(sky.slice(5, 7), 16)],
    [parseInt(twilight.slice(1, 3), 16), parseInt(twilight.slice(3, 5), 16), parseInt(twilight.slice(5, 7), 16)],
    blur) : sky;

  // season: snow flashes across the ground in the middle of the run
  const snow = clamp(Math.sin(days * 0.9 * Math.PI) * 0.8 * (1 - blur) + (p > 0.55 && p < 0.7 ? 0.3 : 0));
  const ground = lerpHex([60, 92, 54], [236, 240, 245], snow);

  // sun streaks into an arc once blurred
  const sunR = 14;
  const sunPos: [number, number, number] = [sunX * sunR, sunY * sunR * 0.8, -4];

  // the laboratory fades away: walls first drawn, then dissolve
  const lab = 1 - clamp((p - 0.12) / 0.2);

  // camera: slight push-in
  const camZ = interpolate(f, [0, N - 1], [9, 7.5]);

  return (
    <AbsoluteFill style={{ background: bg }}>
      <Camera3d transform={Transform.fromXyz(0, 2.4, camZ).lookingAt([0, 1.1, 0])} projection={{ Perspective: { fov: (52 * Math.PI) / 180 } }} />
      <AmbientLight brightness={mix(60, 220, dayness)} />
      <DirectionalLight
        transform={Transform.fromXyz(sunPos[0], Math.max(2, sunPos[1] + 6), 6).lookingAt([0, 0, 0])}
        illuminance={mix(1500, 11000, dayness)}
        shadow_maps_enabled
      />

      {/* ground */}
      <Mesh3d transform={Transform.fromXyz(0, -0.1, -4)}>
        <Cuboid half_size={[14, 0.1, 12]} />
        <StandardMaterial base_color={ground} perceptual_roughness={0.95} />
      </Mesh3d>

      {/* sun / moon */}
      <Mesh3d transform={Transform.fromXyz(sunPos[0], sunPos[1] + 3, sunPos[2])}>
        <Sphere radius={mix(0.6, 1.1, blur)} />
        <StandardMaterial base_color="#ffe9a8" emissive={sunY > 0 ? "#ffd070" : "#b8c4e8"} />
      </Mesh3d>

      {/* laboratory: a bench and clock that dissolve */}
      {lab > 0.02 && (
        <Entity transform={Transform.fromXyz(0, 0, -1).withScale([lab, lab, lab])}>
          <Mesh3d transform={Transform.fromXyz(-3.2, 0.5, -1)}>
            <Cuboid half_size={[1.2, 0.5, 0.6]} />
            <StandardMaterial base_color="#6b4a2f" />
          </Mesh3d>
          <Mesh3d transform={Transform.fromXyz(3.4, 1.6, -2)}>
            <Cylinder radius={0.55} half_height={0.06} />
            <StandardMaterial base_color="#d9d2c0" />
          </Mesh3d>
        </Entity>
      )}

      {/* trees grow, spread, pass away */}
      {trees.map(([x, z], i) => {
        const life = clamp(Math.sin((days * 0.6 + i * 0.37) * Math.PI) * 1.3);
        const g = mix(0.05, 1, life);
        const leaf = lerpHex([50, 120, 50], [170, 120, 50], clamp(Math.sin(days * 2 + i)) * 0.6);
        return (
          <Entity key={i} transform={Transform.fromXyz(x, 0, z).withScale([g, g, g])}>
            <Mesh3d transform={Transform.fromXyz(0, 0.6, 0)}>
              <Cylinder radius={0.12} half_height={0.6} />
              <StandardMaterial base_color="#5a3f2a" />
            </Mesh3d>
            <Mesh3d transform={Transform.fromXyz(0, 1.9, 0)}>
              <Cone radius={0.9} height={1.8} />
              <StandardMaterial base_color={leaf} />
            </Mesh3d>
          </Entity>
        );
      })}

      {/* buildings rise faint and fair, and pass like dreams */}
      {towers.map(([x, z, w, h], i) => {
        const rise = clamp(Math.sin(clamp((p - 0.45 - i * 0.04) / 0.45) * Math.PI) * 1.4);
        const y = mix(-h, 0, rise);
        return (
          <Mesh3d key={i} transform={Transform.fromXyz(x, y + h / 2, z)}>
            <Cuboid half_size={[w / 2, h / 2, w / 2]} />
            <StandardMaterial base_color="#c9d3e6" perceptual_roughness={0.6} />
          </Mesh3d>
        );
      })}

      {/* the machine: brass and ivory, rocking harder as it speeds up */}
      <Entity transform={Transform.fromXyz(0, 0.5, 0).withRotation(Quat.fromEuler("XYZ", 0, 0, Math.sin(f * 0.9) * 0.02 * p))}>
        <Mesh3d>
          <Cuboid half_size={[0.9, 0.12, 0.6]} />
          <StandardMaterial base_color="#c9a54a" metallic={0.8} perceptual_roughness={0.3} />
        </Mesh3d>
        <Mesh3d transform={Transform.fromXyz(-0.75, 0.55, 0)}>
          <Cuboid half_size={[0.06, 0.55, 0.5]} />
          <StandardMaterial base_color="#efe8d4" />
        </Mesh3d>
        <Mesh3d transform={Transform.fromXyz(0.75, 0.55, 0)}>
          <Cuboid half_size={[0.06, 0.55, 0.5]} />
          <StandardMaterial base_color="#efe8d4" />
        </Mesh3d>
        <Mesh3d transform={Transform.fromXyz(0, 0.35, 0.05)}>
          <Cuboid half_size={[0.25, 0.22, 0.25]} />
          <StandardMaterial base_color="#3a2a22" />
        </Mesh3d>
        {/* the Traveller, a stand-in figure */}
        <Mesh3d transform={Transform.fromXyz(0, 0.9, 0.05)}>
          <Cuboid half_size={[0.2, 0.3, 0.14]} />
          <StandardMaterial base_color="#4a3b2a" />
        </Mesh3d>
        <Mesh3d transform={Transform.fromXyz(0, 1.4, 0.05)}>
          <Sphere radius={0.15} />
          <StandardMaterial base_color="#d8b99a" />
        </Mesh3d>
      </Entity>
    </AbsoluteFill>
  );
}

registerRoot(() => <Composition id="tm-iv-timelapse" component={Scene} width={640} height={480} fps={30} durationInFrames={N} />);
