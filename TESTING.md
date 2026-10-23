# Testing xVine 0.3 — preview build

xVine is XIO's **private offline Internet**. It keeps large public archives on
your computer, such as Wikipedia, Wiktionary, Stack Exchange, Project
Gutenberg and iFixit. You browse and search them in a normal web browser, with
no Internet connection needed once they're downloaded.

This preview covers the **library, search and reading**. AI-written pages come
in a later build.

## Start it (Linux)

```sh
unzip xvine-0.3.0.zip
cd xvine-0.3.0
./start-xvine.sh
```

Your browser opens at **http://localhost:8749**. If it doesn't (on a server or
remote box, for example), open that address yourself.

- **Node.js:** xVine needs Node.js 22.15 or newer. If your system's Node is
  older or missing, the script offers to download Node 24 LTS into the xVine
  folder. It only does this if you say yes, and it checks the download's
  checksum. That copy isn't installed system-wide.
- **Stopping:** press Ctrl+C in the terminal.
- **Running on another machine:** xVine only listens on this computer
  (127.0.0.1). To reach it from elsewhere, use an SSH tunnel:
  `ssh -L 8749:localhost:8749 that-machine`.

## Things to try

1. **Library → Catalog.** Pick a language and download something small first:
   - *Ray Charles* (3 MB) as a smoke test
   - *Wikipedia in simple English, mini* (530 MB)
   - A Stack Exchange site (30–200 MB)

   Downloads can be paused and resumed. Each one is checked against its
   published SHA-256 checksum before it joins your library.
   - Switch the catalog to **QUEST web archive** for XIO's own crawl of the web,
     as text snapshots. Try the *sample* pack first.
2. **Search** from the home page. Title suggestions appear as you type. Results
   combine every archive, and the filter chips narrow them to one source.
3. **Read.** Open a result, follow links between articles, and click an
   external link. xVine should ask before sending you to the real Internet.
4. **No waiting for indexing.** Archives from the Kiwix catalog ship with their
   own full-text index, and xVine searches it in place. The Library shows
   "Searchable (built-in index)". Only an archive without one gets a background
   index built, with a progress bar; that takes roughly a minute per 300k
   articles.
5. **Random article** on the home page.
6. **Add from disk.** Already have `.zim` files, for example from Kiwix? Paste a
   full path into **Library → Add from disk**, or copy the files into the
   library folder below and restart xVine.

## Where your data goes

Everything lives in `~/.local/share/xvine/`:

| Path | Contents |
|---|---|
| `library/` | Archives |
| `index.sqlite` | The search index |
| `*.json` | State |

Override the location with `./start-xvine.sh --data /big/disk/xvine` or the
`XVINE_DATA` variable. Deleting that folder resets xVine completely.

## Please report

- Your distro, CPU (x86-64 or ARM), and browser.
- Anything that breaks, looks wrong or is confusing, plus the terminal output.
- Search results that are clearly ranked badly. Include the query.
- How long indexing took for which archive, and how big it was.
