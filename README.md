# xVine

XIO's private offline Internet. xVine serves big public archives (Wikipedia,
Wiktionary, Stack Exchange, Project Gutenberg, iFixit and more, in Kiwix's ZIM
format) on `localhost`, with one search across all of them. It is meant for a
normal web browser and never listens on the network.

```bash
node server/main.js            # starts on http://localhost:8749 and opens the browser
node server/main.js --no-open --port 8749 --data D:\xVineData
```

It needs Node 22.15 or newer, and has **no npm dependencies**.

## Where things live

| What | Where |
|---|---|
| Code | here: `server/` (Node) and `web/` (UI) |
| Archives, index, state | `%LOCALAPPDATA%\xVine` on Windows, `~/.local/share/xvine` on Linux, `~/Library/Application Support/xVine` on macOS. Override with `--data` or `XVINE_DATA` |

Data never goes in this folder. The site tree is mirrored to the public web
server, and archives are many gigabytes.

## How it fits together

- **`server/zim/reader.js`** is a pure-JS ZIM reader with random access. Opening
  a 100 GB archive costs milliseconds and a few MB of cache. It handles title
  lookups, the title-ordered listings and blob range reads.
- **Search** merges three signals in `server/search.js`:
  - Instant title matches straight from each archive's own title index, so a new
    archive is searchable immediately.
  - **The full-text index Kiwix embeds in each ZIM** (`X/fulltext/xapian`), read
    in place by `server/zim/xapian.js`. That is a pure-JS reader for Xapian's
    "glass" format: B-tree, posting lists and document lengths.
    `server/zim/fulltext.js` handles querying the way libzim indexes:
    unaccented, Snowball/Porter2-stemmed (`porter2.js`), CJK n-grams, AND with
    fallbacks, and BM25 using Xapian's parameters. IDF is computed across all
    archives together, so their scores merge fairly. There is no indexing step:
    285k articles answer in 5–60 ms on this PC.
  - For archives without an embedded index (and QUEST pages later): BM25 over
    xVine's own SQLite FTS5 index (`server/store.js`). It is built in a worker
    thread (`server/indexer.js`) at about 60 s per 300k articles and can resume
    after an interruption.
- **Node versions:** on Node 18 (Android) the core falls back to the vendored
  pure-JS zstd decoder (`server/vendor/fzstd.js`, MIT). Without a SQLite driver
  it relies on the embedded indexes alone.
- **Library** (`server/library.js`) picks up any `.zim` in the library folder,
  plus archives added by path. Each archive gets a stable id (`name_flavour`,
  without the date), so links and citations survive updates.
- **Downloads** (`server/downloads.js`) come from two catalogs
  (`server/catalog.js`):
  - **Kiwix**: the OPDS feed, with metalink mirrors.
  - **QUEST web archive**: XIO's own crawl, packed by `quest/xvine_export.py`
    into ZIMs with a built-in index. It is listed in a small JSON catalog
    (default `https://plus.qwertious.org/quest/xvine/catalog.json`, override
    with `--quest-catalog URL` or `XVINE_QUEST_CATALOG`). Only that catalog's
    own host is accepted as a download source.

  Downloads resume after interruption and are SHA-256 verified before joining
  the library.

## Security model

Archive pages are third-party HTML and JS, so they are kept away from xVine's
controls:

- The UI and API answer on **`localhost:8749`**, while archive pages are served
  from **`127.0.0.1:8749`**. These are different origins, so an archive's
  scripts can't read the API.
- Every POST requires the UI's `Origin` and an `X-xVine` header. That blocks
  CSRF from websites and from archives alike.
- The `Host` header must be one of xVine's own names, which defeats DNS
  rebinding.
- Archive pages sit in a sandboxed iframe that can't navigate the top window.
  External links are held back with an "Open online" prompt.

`test/browser-check.js` checks all of this in a real headless Edge or Chrome.

## Roadmap

1. ~~Library, ZIM reader, unified search, viewer~~ (this)
2. AI pages from a local model: cited, with unsourced claims labelled, and saveable
3. Importing QUEST crawls, plus crawl management inside xVine
4. Background archive updates (with your approval)
5. Windows installer and launcher (until then, `start-xvine.cmd`)

Android: [docs/android.md](docs/android.md). The APK is built by
`android/build_apk.py`.

## License

Copyright (C) 2026 Qwertious

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: use it, change it and share it freely, commercially or not. If you
share it or a modified version, keep this credit, say what you changed, and
release your version under the GPL too, with its source code.

`server/vendor/fzstd.js` is third-party code (fzstd by Arjun Barrett), included
unmodified under its own MIT license: see `server/vendor/fzstd.LICENSE`.
