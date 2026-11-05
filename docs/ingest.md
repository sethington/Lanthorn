# Book ingest and cache (draft v0)

Runs whenever a book is loaded. Results are cached and reused.

## Default: lazy

Reading starts immediately. Analysis runs in the background: chapter 1 first, then ahead of the
reader's position, with visible progress. "Analyze whole book" is an opt-in button and shows a
token estimate first (Pride and Prejudice is ~170K tokens in, before output and retries).

## Passes

1. **Parse**: detect chapters, strip front matter, hash text (book identity).
2. **Entity pass**: candidate characters, locations, motifs per chapter. Chapters independent, parallel.
3. **Bible merge**: dedupe across chapters, fix style guide.
4. **Scene pass**: segment each chapter, emit scene JSON against the fixed bible. Scenes independent, parallel.
5. **Render**: on demand, ahead of the reader. Not part of load.

No serial rolling summary through the whole book. Passes 2-3 replace it.

## Spoiler control

Every bible entry carries `from_span` (where it first appears). A scene's prompt only sees entries
introduced at or before its own span.

## Cache

- SQLite in the app data dir. One row per scene and per bible entry, each with a status.
- Analysis key: book hash + schema version + prompt version + provider/model.
  Schema bump invalidates. Model change offers to keep old results.
- Render key (separate): scene hash + block library version + style.
- Resumable: quitting mid-book resumes at the next unfinished scene.

## User overrides

Edits to a scene or bible entry are stored apart from model output and survive re-analysis.

## Later

Exportable analysis file so a public-domain book analyzed once can be reused without spending tokens.
Keep the cache format portable.
