// Scenes are analysed per chapter with the chapter's own sentence numbers (so cached analyses stay valid); the reader joins chapters into
// one text, so a scene is moved by the chapter's first sentence number before it is used.
import type { Scene } from "./scene";

export function shiftScene(s: Scene, base: number, ch: number): Scene {
  return {
    ...s,
    ch,
    from: s.from + base,
    to: s.to + base,
    beats: (s.beats ?? []).map((b) => ({ ...b, at: b.at + base })),
    audio: { ...s.audio, spots: (s.audio?.spots ?? []).map((x) => ({ ...x, at: x.at + base })) },
    shots: s.shots?.map((x) => ({ ...x, from: x.from + base })),
    lines: s.lines?.map((x) => ({ ...x, at: x.at + base })),
    acting: s.acting?.map((x) => ({ ...x, at: x.at + base })),
    stage: s.stage?.map((x) => ({ ...x, at: x.at + base, to: x.to + base })),
  };
}
