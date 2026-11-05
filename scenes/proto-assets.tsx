import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from "raea";
import { Bloom, DepthOfField, Environment, Grade, Model, Shadows, ToneMapping, VolumetricFog, FogVolume } from "raea/3d";
import { StandardMaterial } from "raea/pbr";
import { Cuboid, Mesh3d, Plane3d } from "raea/mesh";
import { DirectionalLight, PointLight } from "raea/light";
import { Transform } from "raea/transform";
import { Camera3d } from "raea/camera";
import { Affine2 } from "raea/math";

const P = (id: string, file: string) => staticFile(`polyhaven/${id}/${file}`);

function Scene() {
  const f = useCurrentFrame();
  const t = f / 90;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Camera3d transform={Transform.fromXyz(-1.4 + t * 0.6, 1.3, 5.2).lookingAt([0.4, 1.4, 0])} projection={{ Perspective: { fov: (38 * Math.PI) / 180 } }}>
        <DepthOfField focal_distance={5.4} aperture_f_stops={2.2} />
      </Camera3d>
      <Environment src={P("belfast_sunset_puresky", "belfast_sunset_puresky_2k.hdr")} intensity={0.55} rotation={0.9} background />
      <DirectionalLight transform={Transform.fromXyz(-6, 4, 5).lookingAt([0, 0, 0])} illuminance={9000} color="#ffb27a" shadow_maps_enabled />
      <Shadows distance={30} firstCascade={8} cascades={2} mapSize={2048} />
      <Bloom intensity={0.9} threshold={0.9} />
      <ToneMapping mode="aces" exposure={-0.2} />
      <Grade vignette={0.35} />

      <Mesh3d transform={Transform.fromXyz(0, 0, 0)}>
        <Plane3d normal={[0, 1, 0]} half_size={[60, 60]} />
        <StandardMaterial
          base_color_texture={P("forrest_ground_01", "diff.jpg")}
          normal_map_texture={P("forrest_ground_01", "nor.jpg")}
          metallic_roughness_texture={P("forrest_ground_01", "arm.jpg")}
          occlusion_texture={P("forrest_ground_01", "arm.jpg")}
          metallic={1}
          perceptual_roughness={1}
          uv_transform={Affine2.fromScale([40, 40])}
        />
      </Mesh3d>

      <Model src={P("jacaranda_tree", "jacaranda_tree_1k.gltf")} position={[7, 0, -9]} scale={0.7} />
      <Model src={P("boulder_01", "boulder_01_1k.gltf")} position={[-3.2, 0, -1.5]} scale={0.9} />
      <Model src={P("tree_stump_01", "tree_stump_01_1k.gltf")} position={[-1.4, 0, 1.2]} scale={1.2} />
      <Model src={P("Lantern_01", "Lantern_01_1k.gltf")} position={[1.2, 0, 0.6]} scale={1.0} />
      <PointLight transform={Transform.fromXyz(1.2, 0.8, 0.6)} intensity={90000} color="#ffb060" range={9} />
    </AbsoluteFill>
  );
}
registerRoot(() => <Composition id="proto" component={Scene} width={720} height={900} fps={30} durationInFrames={90} />);
