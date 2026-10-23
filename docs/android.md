# xVine on Android

## Status (0.2.0)

There is a working APK, built by `android/build_apk.py` without Gradle:

| Component | What it is |
|---|---|
| Server | nodejs-mobile 18.20.4 runs the unchanged desktop server in-process, under a foreground service (`android/java/.../NodeService.java`) |
| Native bridge | A ~40-line JNI file (`android/jni/xvine_node.cpp`) starts Node and sends its output to logcat |
| UI | The normal web UI in a WebView (`MainActivity.java`), with cleartext allowed only for `localhost` and `127.0.0.1` |
| Search | Uses each archive's embedded Xapian index (pure JS), so there is nothing to index on the phone |
| Archives | Come from the in-app Kiwix catalog, or from **Library → Import a .zim from this device** (the system file picker; the file is copied into the app's storage) |
| Storage | `Android/data/org.xio.xvine/files/xvine/`. Uninstalling the app deletes it |
| Not yet | On-device AI (milestone 2); SD-card placement |

Build:

```
python android/build_apk.py --nodejs-mobile <unpacked nodejs-mobile-v18.20.4-android> --abi arm64-v8a
```

The build also needs the Android SDK (build-tools 34, platform 34), NDK r29 and
JDK 17. Pass `--abi x86_64` for the emulator. The signing key is kept in
`~/.config/xvine-android`.

## Original feasibility study

**Verdict: feasible.** Every part of xVine already runs on phones in some other
product: Kiwix reads ZIM files on Android, llama.cpp runs small models on phones,
and Node can be embedded in an APK. The real constraints are storage, RAM, and
the battery and heat cost of indexing. None of them block it. The desktop core
is being written so that an APK can reuse it rather than fork it.

## Recommended architecture

```
┌──────────────── xVine.apk ────────────────┐
│ Kotlin shell                               │
│  ├─ WebView ──► http://127.0.0.1:8749      │  (Chrome on the phone works too)
│  ├─ Foreground service (keeps it alive)    │
│  ├─ nodejs-mobile ──► xvine/server (same JS as desktop)
│  └─ jniLibs/arm64-v8a/libllama-server.so ──► local AI over localhost
└────────────────────────────────────────────┘
```

- **Server:** [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) runs
  Node inside the app process. Its newest release is **Node 18.20.4**, so the core
  must not depend on anything newer. The project is community-maintained now
  (Janea Systems stopped maintaining it), which is the main long-term risk.
- **UI:** the same web UI, shown in a WebView. Nothing needs rewriting.
- **AI:** llama.cpp built for arm64-v8a. It is shipped as `lib…so` inside
  `jniLibs`, because Android 10+ only lets an app execute files from its
  native-library directory (W^X). xVine talks to it over localhost exactly as on
  desktop.

## What the desktop core does now to keep this possible

| Desktop uses | Missing on Node 18 | What the core does |
|---|---|---|
| `zlib.zstdDecompressSync` (Node ≥ 22.15) | yes | `server/zim/codecs.js` falls back to a pure-JS zstd decoder |
| `node:sqlite` (Node ≥ 22.5) | yes | All SQL goes through `server/store.js`; on Android it would use `better-sqlite3` built for arm64. That module bundles its own SQLite with FTS5, which matters because Android's system SQLite does not reliably have FTS5 |
| Native npm modules | — | There are none. The ZIM reader, HTTP server and downloader are plain JS |

## Phone constraints

**Storage.** These are the current Kiwix sizes for all of English Wikipedia:

| Flavour | Contents | Size |
|---|---|---|
| mini | Introductions and infoboxes | 14 GB |
| nopic | Full text, no images | 53 GB |
| maxi | Full text and images | 127 GB |

mini or nopic fits on many phones or an SD card. Topic archives (medicine, maths,
Simple English) are 0.05–3 GB. Archives go in app-specific storage
(`getExternalFilesDirs`, which includes the SD card and needs no permissions),
with an import path through the Storage Access Framework.

**AI.** 2026 community reports put 2B-class models (Gemma 4 E2B, Qwen 3.5 2B)
at about 6–10 tokens per second on phones, with flagships much faster. The
desktop auto-detect step carries over:

| Phone RAM | AI setting |
|---|---|
| ≥ 8 GB | 2–4B model |
| 4–6 GB | About 1B model, or AI off |

A cited AI page takes roughly 30–60 s on a mid-range phone, and the text streams
in while it is being written.

**Indexing.** This is the expensive part. xVine builds its own full-text index
over each archive. That is fine on desktop, but for 6–7 million articles it would
mean hours of CPU on a phone. Two ways around it:

1. **Read the index the ZIM already ships with.** Kiwix ZIMs embed a Xapian
   full-text index (`X/fulltext/xapian`). A JS reader for it would make search
   over all of Wikipedia instant with no indexing at all, on phone and desktop.
   **This is the recommended follow-up before an Android build.**
2. Build the index on a desktop and copy it to the phone with the archive.

**Lifecycle.** Downloads and indexing must run under a foreground service with a
notification, or Android will kill them.

## Fallback if nodejs-mobile becomes a dead end

Port only the server layer to Kotlin (Ktor or NanoHTTPD), keep the web UI as it
is, and use **libkiwix**, the official C++ library behind the Kiwix Android app,
with JNI bindings, for ZIM reading and Xapian search. This is more work but gives
the best performance and battery life. The web UI and the HTTP API are the
contract that keeps this option open.

## Tooling here

This machine has already built APKs (`ZX81/android/build_apk.py` uses the
Android SDK and NDK directly, without Gradle). nodejs-mobile ships as an AAR plus
prebuilt `libnode.so`, which fits the same Gradle-free approach.
