# Lanthorn product spec (decisions so far)

Supersedes nothing; extends README, scene-schema.md, ingest.md.

## Principles

1. **Everything is generated from the text at read time.** Hand-written scenes (scenes/*.tsx) are
   reference output for the compiler, never product content.
2. **The LLM selects and directs; it does not model.** It picks assets from a licensed catalog and
   describes the scene as JSON. A compiler turns JSON into a raea composition.
3. **Bar: modern AAA game / film look.** Not reachable with primitives. Needs real assets, HDRI
   lighting, PBR materials, volumetrics, post, and characters (see Assets).

## Art direction = derived, overridable

- Ingest scans the book (sampled passages, title, front matter) and produces a **style profile** in
  the bible: genre, era, tone, palette, camera language, and a render preset (lighting rig, grade,
  post stack, look mode).
  - Epic adventure -> cinematic (filmic grade, HDRI sky, volumetric light, wide lenses).
  - Others map to other presets (storybook paint, noir, gothic horror, ...). Preset list is open.
- User can override the profile per book in book settings. Override survives re-analysis.
- Engine constraints that shape presets: effects (bloom, grade, tone map) are fixed per piece, not per
  frame; the `paint` look freezes sky colour; background colour does not animate (sky must be 3D).

## Assets

- LLM picks from a catalog index (tags + embedding), by id. It never invents geometry.
- Sources are CC0 first (Kenney, Quaternius, Poly Haven models/HDRIs, ambientCG textures). CC-BY
  items are allowed only with attribution tracked per asset. Note: "Apache/MIT" governs code; 3D
  assets are almost always CC0 or CC-BY, so license is a per-asset field in the catalog.
- Characters: raea's Anny bodies + motion capture (clips carry their own licenses; 100STYLE needs credit).
- Catalog is versioned; render cache keys include the catalog and block-library versions.

## Scene continuity

- Scenes form a chain. Each scene gets: bible, previous scene's **end state** (time of day, weather,
  lighting, camera, character positions), and the next passage. Generation runs ahead of the reader.
- Crossing a scene boundary in the text cross-dissolves the panel to the next scene (two layers,
  ~0.6 s). Where the next scene isn't ready, hold a living loop of the previous scene's ambient layer,
  never a frozen last frame.
- `visual: false` passages hold the current scene.

## Sound

- Each scene carries `audio`: an ambient bed (per location/mood) and spot sounds anchored to sentence
  ids ("a clap of thunder"). Crossfades with scene changes.
- **No large downloads.** raea's local foley model (Stable Audio Open, ~2 GB plus a Python env, Stability
  Community License) was rejected as a dependency (decided 2026-11-05). Sound is synthesised in the webview
  (Web Audio, `src/lib/audio.ts`): noise-based wind/rain/room tone, thrum, insects, a mood pad, and spot effects
  (clink, impact, thunder, whoosh, patter, steps, ticks, creak, chime). Cues it can't make are reported, not faked.
- Later, optionally: a small CC0 sample pack (a few MB, per-asset licence tracked like the 3D catalog) for cues
  synthesis does poorly. Voices are out of scope.
- Driven by reading position: beds crossfade on scene change; spots fire when the reading line moves forward across
  a cue sentence (not on jumps). Off until the user turns it on (browsers need a gesture; not everyone wants it);
  toggle in the top bar, volume and test buttons in Settings.

## Settings page (LLM connection)

- Providers: detected agent CLIs (claude, codex, hermes) and OpenAI-compatible endpoints
  (base URL, model, key). "Test connection" per provider.
- Per-job routing: book scan, bible, scene JSON, optional vision frame-check.
- Secrets in the OS keychain via Tauri, never localStorage or plain files.
- Also: art-direction override per book, sound, cache location and size, render quality.

## Build order (proposed)

1. Settings + provider interface + live text -> scene JSON for the open chapter (dynamic from here on).
2. Asset catalog + compiler (scene JSON -> raea composition), replacing hand-written scenes.
3. Scene chain, continuity state, cross-dissolve, ahead-of-reader generation queue.
4. Style profile from book scan + presets + per-book override.
5. Audio.

## Importing books (built)

- Book model (`src/lib/book.ts`): title, author, chapters (text + paragraphs). Every importer produces it; only text is
  kept (imported content is untrusted: no HTML stored or rendered).
- Formats: EPUB (fflate, MIT: metadata, spine, TOC, front-matter skipped, zip-bomb limits), text and Markdown (chapters
  from Roman-numeral, "Chapter N" or # headings), saved HTML and pasted links (Mozilla Readability, Apache-2.0; the Rust
  side fetches because the webview can't: http/https only, 10 MB cap). PDF, DOCX and Kindle formats are refused with a
  clear message for now.
- Library lives in the app data dir (`library/`), not the cache, so clearing caches never deletes books. File > Open Book
  (⌘O) opens the library; drag a file onto it, choose a file, or paste a link.
- A chapter's analysis and render caches are keyed by a hash of its text, so re-importing the same text reuses them.
- Not yet: browser extension / `lanthorn://` deep link (next), PDF, DOCX.

## Cutscene direction (built: model and timing; playing it needs the embedded world)

Decided 2026-11-05: the book plays like in-game cutscenes, film-style (advances by itself; pause, skip a line, go back).

- Scene JSON gains optional `shots`, `lines`, `acting` (src/lib/scene.ts; prompt p2). Old analyses (p1) still play: the
  director fills in what's missing.
- `src/lib/director.ts`: `buildTimeline` (per-sentence hold from reading speed, paragraph breaths, scene transitions: fade
  for a new place or a time jump, dissolve otherwise), `autoShots` (establish wide, then vary size and angle, close on
  dialogue, never the same picture twice), `Player` (play/pause/seek/skip/back/speed; yields scene, shot, progress, fade).
  Tested: `npm run test:director`. Chapter IV of the example plays in 11.8 minutes.
- The resolver turns each shot into a camera rig (framing sets lens and distance, angle the height, focus the target).
  The world takes the director's state as keys: `Narrative`, `Shot`, `ShotP`, `Fade`, `Control`.
- Not yet: the UI that plays it (full-window world, letterbox, subtitles with speaker names, controls), acting
  animations for each `do`, and voices (macOS speech, optional, off by default). Close-ups show how crude the figures'
  faces are: they need eyes and expression before cutscenes go close.

## The film plays inside the reader (built 2026-11-05)

No separate cutscene mode or Play button: the reader's right-hand panel *is* the live raea world.

- `src/Cutscene.vue` sits in the stage panel (`host=".stagebox"`). It builds the timeline, runs the `Player`, prepares each scene
  as a world bundle (`scene_world`: assets fetched, `raea bundle --composition-bundle`, cached by key), tells the world the
  director's state every ~30 ms (`narrative`, `shot`, `shotp`, `control`) and keeps the pane black until a world is on screen.
- The text follows the film (`@beat` scrolls the reading line to the sentence); scrolling the text by hand moves the film to
  that sentence. Space plays/pauses, left/right step a line. Click the picture to take the camera, Esc to give it back.
- The picture's shape follows the panel's shape when the film starts; the surface is created once at that size and the layer
  scales it. The native view is placed from the page's top (`contentLayoutRect`), not the window's.
- Loads: 0.7 to 4 s per scene, hidden behind the fade. Before each load the engine drops any drawable the window holds (a
  covered window never frees it, which made a load take 27 s instead of 4), and the film pauses while the window is hidden.
  Background preloading of the next scene is not possible: the engine's `Live` can't move between threads.
- A scene that fails to load twice is skipped (the previous scene is held). Skies are loaded at 1k (fast loads).
- Dev: `scripts/dev-wait.sh` waits for a restarted app; the bridge has `world:cmd:{json}` (`snapshot`, `geom`, `status`),
  `cut:pause|play|next|prev|seek:N`, `eval:<js>`.

## Looks (2026-11-05)

- Room: walls and ceiling are thin solid boxes (the side-wall planes had their half-sizes swapped, which left a black gap at the back
  corner; zero-thickness planes also let shadows leak). The near wall closes the room for a camera inside.
- The square speckles on skin, hair and clothes came from the sky image's sun pixels reflecting off every surface (switching the
  environment off removed them). Interiors now use an overcast sky (no sun disc); `RUNTIME_VERSION` is rt9.
- Faces: eyes (white, iris, pupil, catch-light, lid), brows, ears, nose with nostrils, lips with a mouth line, a jaw that blends
  into the skull. Entities with children need an explicit `transform` (a bare `<Entity>` drops its children's place in the head).
- `scripts/try-live.sh <live cache dir> out.png [frame] [keys]` renders one frame with the current runtime headless; `CAM="fx,fy,fz,tx,ty,tz"`
  places the free camera (close-ups), `RT=file.tsx` swaps the runtime (A/B tests).

## Cleanup (2026-11-05)

The baked-frame path is gone: `raea render` to JPEG clips, the frame canvases and cross-dissolve in `App.vue`, the render queue,
the Explore window, the `scene_render`/`scene_cached`/`scene_explore` commands and the `image` crate. Prepared worlds live in
`live/<key>/` and are pruned at start-up (older engine versions, abandoned partial ones, over 3 GB oldest-first); the old
`render/` cache is deleted by that prune. `App.vue` went from 828 to about 590 lines.

## Position-driven, not played (2026-11-05, supersedes the film-style clock above)

There is no player, timer, play button or auto-scroll. `Cutscene.vue` maps the reading position (sentence + how far through it)
through the director's timeline to a scene, shot, fade and time of day, eases toward it, and tells the world. Scroll back and it
winds back; stop and it holds still (the world's own idle motion, such as breathing, continues). Scenes load as the reader
reaches them (black while loading). Clicking the picture takes the camera; Esc, or reaching another scene, gives it back.
Sound already follows the reading position (`engine.onPosition`). `lib/director.ts`'s `Player` is now only a lookup (`at(t)`).

## No fades while reading; one world per place (2026-11-05)

- Consecutive scenes with the same location, interior flag and weather share one world (`groups` in `Cutscene.vue`; a picture-less
  scene stays in the world before it). Their shots are combined into one list, and the world's time of day runs across the whole
  group. Only a change of place loads a new world (a 16-scene chapter made about 4 worlds).
- The director's fade/dissolve transitions are not used here. Shots are camera moves: the runtime keeps a smoothed camera
  (`sm` in the world state) that glides toward the wanted shot, so a "cut" is a fast move. A change of place holds the last
  picture (with a small "moving on…" pill) until the next world is ready; the pane is black only before the first world.

## Stage cues: the world performs the text (2026-11-05)

Scenes may carry `stage`: cues the model (or a package author) writes, each `{k, at, to, what?, how?, amount}`, played by reading
position (`Cue` in `src/lib/scene.ts`; prompt `p3`). Kinds: `moon` (how "new>full": a card showing one of 16 generated phase
pictures, `scripts/make-moon.py` -> `runtime/moon/`, shipped inside the app), `sun` (a streak of fire across the sky with a trail),
`grow` (what: trees/flowers = catalog models, buildings/towers = procedural glassy towers; how: sprout | rise | melt), `streak`
(speed lines past the camera), `flash` (strobe | lightning: the light pulses), `cam` (look_up | roll | spin | crane | punch), `quake`.
- The resolver (`StageR`) turns sentence spans into the world's 0..1 progress and places models in a ring 16-36 m around the scene
  centre; `runtime/scene.tsx` renders them (`Moon`, `SunStreak`, `Grow`, `Streaks`) and applies camera/light effects.
- **Framing:** while a cue plays the camera pulls back to about 12 m from the subject (at a gentle angle, never overhead), widens
  its lens, and for sky cues tilts up to find the moon or sun, so a close-up never hides the event.
- Example: `examples/the-time-machine-iv` scene s6 has hand-authored cues (streaks, strobe, sun, moon new>full, trees, towers).
- Open: stylised looks (picked from the book's text, per-book override), more kinds, a critic pass that renders a frame and
  checks the cue reads, and re-analysis of existing books to get cues (the prompt version changed to p3).

## Looks (styles), picked from the book and overridable (2026-11-05)

Six looks (`src/lib/style.ts`, drawn by raea's `<Look>` in `runtime/scene.tsx`): **cinematic** (filmic realism), **storybook**
(painted, strokes, washed textures), **cartoon** (flat colour, ink outline), **dream** (misty pastel paint with glow), **noir**
(Obra-Dinn style ink/paper dither) and **pixel** (world-fixed pixel art). The painted looks fill the sky from the world's hour and
weather, and use one tight shadow cascade.
- **Picked from the text:** on opening a book the keyword heuristic gives an instant pick; then the Book-scan model (Settings >
  routing > "Book scan") is asked once per book, from the title, author and excerpts, and its pick is cached (`store/style/<book>`).
  No model set up: the keyword pick stands.
- **Always overridable:** Details > Look, per book (`localStorage lanthorn:style:<book>`, so clearing caches keeps it). Changing it
  remounts the world in the new look.
- Not done: a package manifest `style` field (author's recommendation, overridable), a global default look in Settings, and a
  look per chapter.

### Look precedence, per chapter and global (2026-11-05)

Most specific wins, and the reader's own choices beat the package's: **chapter choice > book choice > default look (Settings >
Look) > package chapter `style` > package `style` > the look picked from the text**. Details > Look has a chapter select and a
book select and says where the current look comes from. Packages carry `style` on the manifest and on each chapter (the Rust
validator rejects unknown looks; `npm run lanthorn -- check` too). The look picked from the text is still per book, not per chapter.

## Acting, faces and more cues (2026-11-05)

- **Acting:** the scene's `acting` moves (sit, stand, crouch, walk_to, reach, use_lever, gesture, look_at, turn) now play: each
  runs from its sentence to that character's next move, resolved to the world's progress (`Fig.acts`), blended in the runtime
  `Figure` (pose blending, walking to a target, arm gestures, head turns).
- **Faces:** blinking on each figure's own beat; the expression follows the scene mood (worry, wonder, joy, sorrow, anger).
- **Cues added:** `creature` (procedural crab / butterfly / bird crossing the view), `dim` (eclipse with corona | dusk | dark; a
  dark veil so painted looks dim too), `sun` how "red" (a huge red sun low on the horizon). Prompt `p4` lists the exact `how`
  words; the first real run (chapter XIV of the full Time Machine) used undefined words under `p3` and missed the creatures and
  eclipses entirely, and under `p4` cued them all.
