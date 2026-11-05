# Scene schema (draft v0)

What the LLM may say about a scene. Lanthorn compiles it to a raea composition from a
building-block library. Anything not expressible here cannot be drawn. The schema and the
library are the same design problem.

Derived from The Time Machine ch. IV (time-lapse, first-person, abstract sensation) and ch. V+
(arrival: Sphinx, garden, Eloi). Not yet tested on the other four books.

## Pipeline objects

1. **Bible** (per book, persistent, updated as reading advances)
2. **Scene** (one per segment of text, produced from bible + rolling summary + passage)
3. **Composition** (compiled, not LLM-written, on the endpoint path)

## Bible

```json
{
  "style": { "look": "low-poly dusk", "palette": ["#1b2a41", "#e0a458"], "lighting_default": "soft overcast" },
  "characters": [
    { "id": "traveller", "desc": "Victorian man, mid-30s, coat, travel-worn", "build": "slim", "colors": ["#4a3b2a"] }
  ],
  "locations": [
    { "id": "laboratory", "desc": "Victorian workshop, brass and quartz machine", "era": "1890s" }
  ],
  "motifs": ["white sphinx on bronze pedestal"]
}
```

Rules: LLM may add or amend entries; Lanthorn stores them in a file it owns. Ids are stable
across scenes. Scenes reference ids, never re-describe.

## Scene

```json
{
  "id": "tm-04-02",
  "span": { "start": 614, "end": 680 },
  "kind": "timelapse",
  "visual": true,
  "setting": { "location": "laboratory", "interior": true },
  "time": { "start": "morning", "end": "ambient-blur", "progression": "accelerating" },
  "weather": "clear",
  "subjects": [
    { "ref": "traveller", "pose": "seated-on-machine", "action": "gripping lever", "position": "center" },
    { "ref": "machine", "state": "operating", "position": "center" }
  ],
  "props": [
    { "type": "clock", "position": "wall-left" },
    { "type": "workbench", "position": "back" }
  ],
  "effects": ["day-night-flicker", "walls-fade"],
  "mood": "dread",
  "camera": { "framing": "medium", "angle": "eye", "motion": "static" },
  "confidence": 0.8
}
```

### Fields

- **kind**: `static` | `timelapse` | `motion` | `abstract` | `interior-monologue`.
  `abstract` and `interior-monologue` render mood, color, and motion only.
- **visual**: `false` means no scene is shown (hold the previous one). Most dialogue and
  exposition passages are `false`. This is the main defence against rendering every paragraph.
- **span**: character or line offsets, so the reader UI can map scroll position to scene.
- **setting.location**: bible id, or a new location with an inline `desc` that gets promoted into the bible.
- **time**: time of day plus optional change across the scene. Drives lighting and sky.
- **subjects**: bible entities in the scene, each with position, pose, action drawn from a fixed vocabulary.
- **props**: items from the block library only (see below). Unknown prop types are dropped and logged, not guessed.
- **effects**: from a fixed list of named effects.
- **confidence**: LLM's own read of how well the passage specifies this scene. Low confidence holds the previous scene.

## Building-block library (v0 targets)

Needed for Time Machine ch. III-V, in priority order:

- **Terrain / sky**: hill, plain, riverbank, garden, ruins; sky with sun/moon/stars and time-of-day lighting
- **Structures**: room shell (interior), colossal building, pedestal + statue, well/shaft
- **Figures**: human, small-human (Eloi), generic creature; poses: stand, sit, walk, run, lie
- **Props**: machine (the time machine as a bespoke asset), clock, table, tree, flowers, fire
- **Effects**: day-night flicker, fog, rain, snow, motion blur, fade, glow

Everything is primitive-built and stylised. No sourced assets.

## Open questions

1. How coarse is a scene? One paragraph, one location change, or one chapter section?
   Time Machine ch. IV is one long first-person passage with several visual beats.
2. Do we ask for coordinates, or named slots (left/center/back)? Named slots compile more reliably.
3. How do we handle the framing story (narrator reports the Traveller's account)?
   Probably ignore the frame and draw the account.
4. Fixed pose and action vocabulary size. Too small looks repetitive, too large trips small models.
5. Can the schema carry anything for abstract or horror passages (Cthulhu) that does not
   reduce to objects, such as "wrong geometry" or "oppressive scale"? Likely needs a small
   `atmosphere` block of continuous parameters.
