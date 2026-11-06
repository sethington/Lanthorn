# Lanthorn

A reader that projects scenes beside the text. Open a book, and as you read, Lanthorn works out what the passage looks and
sounds like and builds it as a 3D scene next to the page: lit by real skies, furnished with real models, with weather,
people, and sound that follow where you are in the text.

Named for the old spelling of "lantern", as in magic lantern.

> **Status: early, in active development.** It runs from source on macOS. The reading experience, import, scene
> generation, sound and the package format work. Live interactive worlds (click the picture to take control) are being
> built; see [docs/spec.md](docs/spec.md) for the design and what's decided.

## How it works

1. You open a book (EPUB, text, Markdown, a saved web page, a link, or a `.lanthorn` package).
2. A language model of your choice reads each chapter and describes its scenes as structured JSON: where, when, weather,
   who is there, what happens, what you'd hear. (A `.lanthorn` package can ship these scenes ready-made and skip this.)
3. Lanthorn turns each description into a physically sized 3D scene from CC0 models, skies and textures
   ([Poly Haven](https://polyhaven.com)), or from assets bundled in a package, and renders it with
   [raea](https://github.com/shinyobjectz/raea).
4. As you scroll, the scene follows your reading position and cross-fades between scenes. Sound is synthesised on your
   machine from each scene's mood and weather.

## Run it

Requirements: macOS, [Rust](https://rustup.rs), Node 22+, and the [raea](https://github.com/shinyobjectz/raea) CLI
(`curl -fsSL https://raea.io/install | sh`). For scene generation, any of: Claude Code, Codex CLI, Hermes Agent, or an
OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM, ...).

```bash
npm install
npm run tauri dev
```

The first run opens the **Library**. Choose a file, drop one on the window, or paste a link. Then:

- **Lanthorn → Settings…** (⌘,): pick the model and provider for each job (book scan, story bible, scenes), manage
  caches, and turn sound on and set its volume.
- **File → Open Book…** (⌘O) or **Lanthorn → Library…** (⌘L): the library of books you've imported.
- **Details** (top right): the scene list for the chapter and the chapter picker.

Books you import are kept in the app's data folder, so clearing caches never deletes them.

### The live world and building the app

The picture is a live raea world drawn by a native library (`liblanthorn_world.dylib`, source in `world/`) that Lanthorn
loads at run time. It carries the whole engine, so it is built separately, inside a raea checkout:

```bash
git clone --depth 1 https://github.com/shinyobjectz/raea ~/sites/raea   # once; needs cmake (brew install cmake)
npm run world      # builds the library (a few minutes the first time) and stages a stripped copy in src-tauri/world/ (~140 MB)
npm run tauri dev  # development: loads ~/sites/raea/target/release/liblanthorn_world.dylib
npm run bundle     # release: builds the library, then the .app with the library inside (Contents/Resources/world/)
```

`LANTHORN_WORLD_LIB=/path/to/lib.dylib` overrides where the app looks. The released app still needs the `raea` CLI on the
user's machine (it bundles each scene), and a distributable build must be signed and notarised with your Developer ID: the
library is signed with the app, so no extra entitlement is needed when both use the same identity.

In the reader, the picture follows the text. Click it to take the camera: drag to look, W/S zoom, A/D slide left and right,
Esc to give it back. Space plays or pauses, left and right arrows step a line.

### Formats you can import

| Format | Notes |
|---|---|
| `.lanthorn` | A package: text, optional ready-made scenes, optional bundled models. See below. |
| `.epub` | Title, author, chapters and reading order are read from the book. DRM-protected files can't be opened. |
| `.txt`, `.md` | Chapters are found from Roman-numeral lines, `Chapter N` lines, or `#` headings. |
| `.html`, a pasted link | The main article text is extracted. Long pages with several `<h2>` sections become chapters. |
| PDF, DOCX, Kindle | Not supported yet. |

## Making a `.lanthorn` package

A package is how you share a book with its scenes and assets: a zip file with the extension `.lanthorn`. Anyone can
download one and open it in Lanthorn (Library → Choose a file…, or drag it onto the Library). You can ship:

- **the text**, split into chapters;
- **scenes**: your own description of what each stretch of the text looks and sounds like, so readers' language models
  aren't needed and everyone sees what you intended;
- **assets**: your own 3D models, placed where you say or matched to props in your scenes.

### Quick start

Build the included example and open it:

```bash
npm run lanthorn -- check examples/the-time-machine-iv
npm run lanthorn -- pack  examples/the-time-machine-iv -o examples/dist/the-time-machine-iv.lanthorn
```

Then in the app: **File → Open Book… → Choose a file…** and pick `examples/dist/the-time-machine-iv.lanthorn`.

### Folder layout

```
my-book/
  manifest.json            required
  chapters/
    one.txt                chapter text, UTF-8, paragraphs separated by blank lines
  scenes/
    one.json               optional: the scenes for that chapter
  assets/
    statue/
      statue.gltf          optional: bundled models (and the files they use)
      statue.bin
      textures/...
```

Only `manifest.json`, `chapters/`, `scenes/` and `assets/` are read. Dot-files are left out when packing.

### `manifest.json`

```json
{
  "format": "lanthorn",
  "version": 1,
  "id": "my-book",
  "title": "My Book",
  "author": "A. Writer",
  "language": "en",
  "description": "One line about it.",
  "license": "CC-BY-4.0",
  "creator": "You",
  "style": "storybook",
  "chapters": [
    { "id": "one", "num": "I", "title": "The Beginning", "text": "chapters/one.txt", "scenes": "scenes/one.json", "style": "dream" }
  ],
  "assets": [
    {
      "id": "statue", "kind": "model", "path": "assets/statue/statue.gltf",
      "tags": ["statue", "sphinx", "white marble"], "height": 3.2,
      "license": "CC-BY-4.0", "author": "Someone", "source": "https://example.com/statue"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `format`, `version` | yes | Always `"lanthorn"` and `1`. |
| `id` | yes | Lowercase letters, digits, `-` and `_` (max 64). Loading a package with the same `id` replaces the old one. |
| `title` | yes | The book's title (shown large at the top of the first chapter). |
| `author`, `language`, `description` | no | Shown in the Library. |
| `license`, `creator` | recommended | What others may do with the package, and who made it. |
| `style` | no | The look you recommend for the whole book: `cinematic`, `storybook`, `cartoon`, `dream`, `noir` or `pixel`. Readers can always override it. Without one, the app picks a look from the book's text. |
| `chapters[]` | yes (1 to 2000) | `id` (unique, same rules as above), `title`, `text` (a `.txt` or `.md` file under `chapters/`), and optionally `num` (e.g. `IV`), `scenes` (a `.json` file under `scenes/`) and `style` (a look for just this chapter, over the book's). |
| `assets[]` | no | Bundled models. Each needs `id`, `kind` (`"model"`), `path` (a `.gltf` or `.glb` under `assets/`), and a `license`. Also give `height` (metres), `tags`, and `author`/`source` for credit. |

Models have no real-world scale of their own, so give each one a `height` in metres. A statue that is 3.2 m tall should
say so; without it the model is treated as 1 m tall.

### Looks

The picture is drawn in one of six looks. A package can recommend one for the book and a different one per chapter (see
`style` above). The reader's own choices always win: a look chosen for a chapter, then one chosen for the book, then their default
look in Settings; after those come the package's chapter look, the package's book look, and finally the look the app picks from
the text.

### Scenes

A scenes file describes a chapter as a list of scenes that together cover it:

```json
{
  "bible": {
    "characters": [{ "id": "traveller", "desc": "Victorian man in a brown coat" }],
    "locations":  [{ "id": "laboratory", "desc": "Workshop with a brass machine" }]
  },
  "scenes": [
    {
      "id": "s1", "from": 0, "to": 3, "visual": true, "kind": "static",
      "location": "laboratory", "interior": true,
      "time": { "start": "morning", "end": "morning", "progression": "steady" },
      "weather": "clear",
      "subjects": [{ "ref": "traveller", "pose": "standing", "action": "presents the machine", "position": "left" }],
      "props": ["time machine", "lantern", "workbench"],
      "effects": [], "mood": "anticipatory",
      "camera": { "framing": "wide", "motion": "push" },
      "beats": [{ "at": 2, "action": "pulls the starting lever" }],
      "audio": { "bed": "quiet workshop hum", "spots": [{ "at": 2, "sound": "metal clink" }] },
      "confidence": 0.9,
      "place": [{ "asset": "statue", "x": -2, "z": -1.4, "height": 3.2 }]
    }
  ]
}
```

**Scenes are tied to the text by sentence number.** `from` and `to` are sentence numbers (counting from 0, inclusive) in
that chapter's text; `beats[].at` and `audio.spots[].at` are sentence numbers inside the scene. To see the numbers:

```bash
npm run lanthorn -- sentences my-book/chapters/one.txt
```

A chapter plays like a cutscene: each sentence is held long enough to read, the camera cuts between shots, and the whole
thing advances on its own (the viewer can pause, skip a line, or go back). `shots`, `lines` and `acting` are how you direct it.

Scenes should tile the chapter: the first starts at sentence 0, each starts right after the previous one ends, and the
last ends at the final sentence. The checker warns about gaps. A scene with `"visual": false` (dialogue or exposition with
nothing to draw) keeps showing the previous scene.

| Field | Values |
|---|---|
| `kind` | `static`, `timelapse` (accelerated time), `motion`, `abstract` (sensation, no objects), `interior` |
| `time.start`, `time.end` | `dawn`, `morning`, `noon`, `afternoon`, `dusk`, `night` |
| `time.progression` | `steady`, `accelerating`, `slowing` |
| `weather` | `clear`, `overcast`, `rain`, `snow`, `fog`, `storm` |
| `camera.framing` | `wide`, `medium`, `close` |
| `camera.motion` | `static`, `push`, `pull`, `orbit`, `drift` |
| `subjects[].position` | `left`, `center`, `right`, `back`, `front` |
| `subjects[].pose` / `action` | Words like *seated*, *standing*, *walking*, *crouching*, *gripping a lever*. |
| `props` | Short noun phrases. Matched first to your bundled assets (by `id` and `tags`), then to the CC0 library. |
| `beats[].action` | Words like *pull the lever*, *overturns*, *the sun…* trigger the matching animation. |
| `audio.spots[].sound` | Words like *thunder*, *impact*, *crash*, *metal clink*, *whoosh*, *hail*, *footsteps*, *clock tick*, *creak*, *bell*. |
| `place[]` | Optional. Put a bundled asset exactly at `x`, `y`, `z` (metres) at the given `height`, with optional `rotY` (radians). |
| `shots[]` | Optional direction. Each shot starts at sentence `from` and runs until the next one: `framing` (`wide`, `medium`, `close`, `extreme_close`), `angle` (`eye`, `low`, `high`, `over_shoulder`), `focus` (a character id, a prop word, or `scene`), `move` (`static`, `push`, `pull`, `orbit`, `drift`, `pan`) and `into` (how you arrive: `cut`, `dissolve`, `fade`). Left out, the director frames the scene itself. |
| `lines[]` | Optional. Who speaks a sentence: `{ "at": 12, "speaker": "traveller", "kind": "dialogue" }` (`kind` is `dialogue` or `thought`). Sentences without an entry are narration; quoted sentences are treated as dialogue even without one. |
| `acting[]` | Optional. What a character does from a sentence on: `{ "at": 3, "who": "traveller", "do": "use_lever", "to": "machine" }`. `do` is one of `walk_to`, `sit`, `stand`, `reach`, `use_lever`, `look_at`, `turn`, `gesture`, `crouch`. |

What the built-in renderer can draw is limited today: hillsides, gardens and rooms; weather; people (as the figures it
knows: a man, a woman, a small robed figure); and the props it finds. A prop it can't place is skipped, not invented.
Bundled models are how you add what it doesn't have.

### Bundled models

- Use `.gltf` (with its `.bin` and textures alongside) or a single `.glb`.
- Every asset must name its `license`. Anything you didn't make should say who did and where it came from
  (`author`, `source`). Don't bundle assets you aren't allowed to redistribute.
- Give `tags` that match the words used in your scene `props`: a prop "the white sphinx" finds an asset tagged `sphinx`.

### Check and pack

```bash
npm run lanthorn -- check my-book                      # errors stop packing; warnings are advice
npm run lanthorn -- pack  my-book -o my-book.lanthorn
npm run lanthorn -- check my-book.lanthorn             # you can check a finished package too
```

(The npm script passes the flags older Node 22 releases need to run it.)

### Safety and limits

A package is untrusted input, so the app checks everything when it loads one, no matter what the checker said:

- Only data is accepted: text, JSON, models, images, skies and sound. **No scripts, programs or HTML are ever unpacked
  or run.** (Packages in this version don't contain code; the scene renderer is part of the app.)
- Paths must stay inside the package (no `..`, absolute paths or symbolic links). Anything else is refused.
- Limits: 600 MB unpacked, 200 MB per file, 5000 files, 2000 chapters, 8 MB per chapter text.
- Removing a book from the Library removes its bundled assets too.

## Project layout

| Path | What |
|---|---|
| `src/` | The app UI (Vue): reader, Library, Settings. `src/lib/` holds the scene schema, resolver, importers, audio engine. |
| `src-tauri/` | The Rust side: LLM providers, library, packages, renderer, caches, menus. |
| `runtime/scene.tsx` | The raea composition that draws any resolved scene (baked frames or a live world). |
| `scripts/lanthorn.mjs` | The package checker and packer. |
| `examples/` | An example package. |
| `docs/spec.md` | Design decisions: what's built, what's planned, and why. |

## Credits and licences

Lanthorn is licensed under the [GNU AGPL-3.0](LICENSE). Copyright (C) 2026 Seth Steele. For other terms, get in touch.

Scenes use CC0 models, skies and textures from [Poly Haven](https://polyhaven.com). 3D rendering is by
[raea](https://github.com/shinyobjectz/raea) (FSL-1.1-ALv2). A package lists the licence, author and source of every asset
it bundles in its manifest; the app doesn't display those credits yet.
