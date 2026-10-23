#!/usr/bin/env node
'use strict';
/* xVine — XIO's private offline Internet. Serves archives and search on
   localhost; never listens on the network.

   node server/main.js [--port 8749] [--no-open] [--data DIR] */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { Store } = require('./store');
const { Library } = require('./library');
const { Search } = require('./search');
const { Catalog } = require('./catalog');
const { Downloads } = require('./downloads');

const VERSION = '0.3.0';

/* ------------------------------------------------------------------ config */

function arg(name, def) {
	const i = process.argv.indexOf('--' + name);
	if (i < 0) return def;
	const v = process.argv[i + 1];
	return v === undefined || v.startsWith('--') ? true : v;
}

function defaultDataDir() {
	if (process.env.XVINE_DATA) return process.env.XVINE_DATA;
	if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'xVine');
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'xVine');
	return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'xvine');
}

/* --log FILE: mirror console output to a file (the Android app has no
   terminal to show it). The file is restarted when it passes 2 MB. */
if (typeof arg('log', null) === 'string') {
	const logFile = arg('log');
	try {
		if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.rmSync(logFile);
	} catch (e) {
		/* no log yet */
	}
	// Synchronous writes: a crash must not lose the line that explains it.
	const write = (level, a) => {
		try {
			fs.appendFileSync(logFile, new Date().toISOString() + ' ' + level + ' ' + a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
		} catch (e) {
			/* nowhere left to report it */
		}
	};
	for (const level of ['log', 'warn', 'error']) {
		const orig = console[level].bind(console);
		console[level] = (...a) => {
			orig(...a);
			write(level.toUpperCase(), a);
		};
	}
	write('INFO', ['node ' + process.version + ' ' + process.platform + '/' + process.arch + ' argv ' + process.argv.slice(2).join(' ')]);
	process.on('uncaughtException', (err) => {
		console.error('uncaught', err);
		process.exit(1);
	});
	process.on('unhandledRejection', (err) => {
		console.error('unhandled rejection', err);
	});
}

const PORT = parseInt(arg('port', process.env.XVINE_PORT || '8749'), 10);
const HOST = '127.0.0.1';
const DATA = path.resolve(arg('data', defaultDataDir()));
const WEB = path.join(__dirname, '..', 'web');
const LIB_DIR = path.join(DATA, 'library');
// QUEST packs (XIO's own crawl) are listed here; see quest/xvine_export.py.
const QUEST_CATALOG = arg('quest-catalog', process.env.XVINE_QUEST_CATALOG || 'https://plus.qwertious.org/quest/xvine/catalog.json');

/* ----------------------------------------------------------------- helpers */

const STATIC_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
};

const BASE_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
	res.writeHead(status, { ...BASE_HEADERS, ...headers });
	res.end(body);
}

function json(res, status, obj) {
	send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readJson(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > limit) {
				reject(new Error('Request too large'));
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
			} catch (e) {
				reject(new Error('Bad JSON'));
			}
		});
		req.on('error', reject);
	});
}

function serveStatic(res, rel) {
	const file = path.normalize(path.join(WEB, rel));
	if (!file.startsWith(WEB + path.sep)) return send(res, 404, 'Not found');
	fs.readFile(file, (err, data) => {
		if (err) return send(res, 404, 'Not found');
		send(res, 200, data, {
			'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
			'Cache-Control': 'no-cache',
		});
	});
}

function openBrowser(url) {
	const cmd =
		process.platform === 'win32'
			? ['cmd', ['/c', 'start', '', url]]
			: process.platform === 'darwin'
				? ['open', [url]]
				: ['xdg-open', [url]];
	try {
		// A missing opener (headless box, no xdg-utils) reports asynchronously.
		spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
	} catch (e) {
		/* no browser: the URL is printed anyway */
	}
}

/* Two origins on one port: the xVine UI and API answer on localhost, archive
   pages on 127.0.0.1. A hostile archive's scripts are therefore cross-origin to
   the API — they can't read it, and POSTs demand the UI's Origin. frame.js
   reports navigation to the viewer and routes external links out. */
const UI_HOST = 'localhost:' + PORT;
const CONTENT_HOST = '127.0.0.1:' + PORT;
const UI_ORIGIN = 'http://' + UI_HOST;
const CONTENT_ORIGIN = 'http://' + CONTENT_HOST;
const CONTENT_CSP = 'frame-ancestors ' + UI_ORIGIN;
const FRAME_TAG = '<script src="/static/frame.js"></script>';

function injectFrameScript(html) {
	const i = html.search(/<\/head>/i);
	if (i >= 0) return html.slice(0, i) + FRAME_TAG + html.slice(i);
	const b = html.search(/<body[^>]*>/i);
	if (b >= 0) {
		const end = html.indexOf('>', b) + 1;
		return html.slice(0, end) + FRAME_TAG + html.slice(end);
	}
	return FRAME_TAG + html;
}

/* -------------------------------------------------------------------- app */

async function main() {
	fs.mkdirSync(LIB_DIR, { recursive: true });
	const dbPath = path.join(DATA, 'index.sqlite');
	const store = Store.open(dbPath);
	if (!store.available) console.log("No SQLite driver: using archives' built-in search indexes only");
	const library = new Library({
		dir: LIB_DIR,
		stateFile: path.join(DATA, 'library.json'),
		store,
		dbPath,
		leadChars: 3000,
	});
	const search = new Search({ library, store });
	const catalog = new Catalog(path.join(DATA, 'cache', 'catalog'), { questUrl: QUEST_CATALOG });
	const downloads = new Downloads({
		dir: LIB_DIR,
		stateFile: path.join(DATA, 'downloads.json'),
		questOrigin: new URL(QUEST_CATALOG).origin,
	});
	downloads.on('complete', (it) => {
		library.addFile(it.path).catch((err) => console.warn('[library] could not add', it.file, err.message));
	});


	async function serveContent(req, res, bookId, rawPath) {
		const book = library.get(bookId);
		if (!book) return send(res, 404, 'No such archive', { 'Content-Type': 'text/plain' });
		const zim = book.zim;
		let urlPath;
		try {
			urlPath = decodeURIComponent(rawPath);
		} catch (e) {
			return send(res, 400, 'Bad path');
		}
		if (!urlPath) {
			if (!book.mainPath) return send(res, 404, 'This archive has no main page');
			return send(res, 302, '', { Location: '/content/' + encodeURIComponent(bookId) + '/' + encodePath(book.mainPath) });
		}
		const { ns, path: p } = zim.locate(urlPath);
		let entry = await zim.findByPath(ns, p);
		if (!entry) return send(res, 404, notFoundPage(book, urlPath), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CONTENT_CSP });
		if (entry.isRedirect) {
			const t = await entry.resolve();
			return send(res, 302, '', { Location: '/content/' + encodeURIComponent(bookId) + '/' + encodePath(zim.urlPathOf(t)) });
		}
		const mime = entry.mimeType || 'application/octet-stream';
		const etag = '"' + crypto.createHash('sha1').update(book.uuid + '\0' + urlPath).digest('base64url').slice(0, 20) + '"';
		const common = {
			ETag: etag,
			'Cache-Control': 'private, max-age=3600',
			'Content-Security-Policy': CONTENT_CSP,
		};
		if (req.headers['if-none-match'] === etag) return send(res, 304, '', common);

		if (/^text\/html/.test(mime)) {
			const html = injectFrameScript((await entry.getData()).toString('utf8'));
			return send(res, 200, html, { ...common, 'Content-Type': 'text/html; charset=utf-8' });
		}
		const size = await entry.getSize();
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
		if (range && size > 0) {
			let a = range[1] === '' ? size - parseInt(range[2], 10) : parseInt(range[1], 10);
			let z = range[1] === '' || range[2] === '' ? size - 1 : parseInt(range[2], 10);
			a = Math.max(0, a);
			z = Math.min(size - 1, z);
			if (a > z) return send(res, 416, '', { 'Content-Range': 'bytes */' + size });
			const chunk = await zim.readBlobRange(entry.cluster, entry.blob, a, z - a + 1);
			return send(res, 206, chunk, {
				...common,
				'Content-Type': mime,
				'Accept-Ranges': 'bytes',
				'Content-Range': 'bytes ' + a + '-' + z + '/' + size,
			});
		}
		const data = await entry.getData();
		return send(res, 200, data, { ...common, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
	}

	async function api(req, res, route, url) {
		const q = url.searchParams;
		if (req.method === 'POST') {
			// Mutations: same-origin pages only (blocks CSRF from websites and
			// from sandboxed archive pages, whose Origin is "null").
			if (req.headers.origin !== UI_ORIGIN || req.headers['x-xvine'] !== '1') {
				return json(res, 403, { error: 'Forbidden' });
			}
		}
		const sources = q.get('sources') ? q.get('sources').split(',').filter(Boolean) : null;

		if (req.method === 'GET' && route === 'status') {
			return json(res, 200, { version: VERSION, data: DATA, libraryDir: LIB_DIR, platform: process.platform });
		}
		if (req.method === 'GET' && route === 'books') return json(res, 200, { books: library.list() });
		if (req.method === 'GET' && route === 'suggest') {
			return json(res, 200, { suggestions: await search.suggest(q.get('q'), { limit: 10, sources }) });
		}
		if (req.method === 'GET' && route === 'search') {
			const page = Math.max(0, parseInt(q.get('page') || '0', 10) || 0);
			return json(res, 200, await search.search(q.get('q'), { sources, page }));
		}
		if (req.method === 'GET' && route === 'random') {
			const pool = [...library.books.values()].filter((b) => (sources ? sources.includes(b.id) : true) && b.zim.titleListing);
			if (!pool.length) return json(res, 404, { error: 'No archives' });
			for (let tries = 0; tries < 40; tries++) {
				const b = pool[Math.floor(Math.random() * pool.length)];
				const i = Math.floor(Math.random() * b.zim.titleListing.count);
				const e = await (await b.zim.entryAt(await b.zim._titleIndexAt(i))).resolve();
				if (e.namespace === b.zim.contentNs && /html/.test(e.mimeType || '')) {
					return json(res, 200, { source: b.id, path: b.zim.urlPathOf(e), title: e.title });
				}
			}
			return json(res, 404, { error: 'Nothing found' });
		}
		if (req.method === 'GET' && route === 'catalog') {
			try {
				if (q.get('source') === 'quest') return json(res, 200, await catalog.quest({ q: q.get('q') || '' }));
				return json(
					res,
					200,
					await catalog.entries({
						q: q.get('q') || '',
						lang: q.get('lang') || '',
						category: q.get('category') || '',
						start: parseInt(q.get('start') || '0', 10) || 0,
						count: Math.min(60, parseInt(q.get('count') || '30', 10) || 30),
					}),
				);
			} catch (err) {
				return json(res, 503, { error: err.message, offline: !!err.offline });
			}
		}
		if (req.method === 'GET' && route === 'catalog/icon') {
			try {
				const png = q.get('quest') ? await catalog.questIcon() : await catalog.icon(q.get('u') || '');
				return send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=604800' });
			} catch (err) {
				return send(res, 404, '');
			}
		}
		if (req.method === 'GET' && route === 'catalog/facets') {
			try {
				return json(res, 200, await catalog.facets());
			} catch (err) {
				return json(res, 503, { error: err.message, offline: !!err.offline });
			}
		}
		if (req.method === 'GET' && route === 'downloads') return json(res, 200, { downloads: downloads.list() });
		if (req.method === 'POST' && route === 'downloads') {
			const body = await readJson(req);
			return json(res, 200, { download: downloads.add(body.entry) });
		}
		let m;
		if (req.method === 'POST' && (m = /^downloads\/([0-9a-f]+)\/(pause|resume|cancel)$/.exec(route))) {
			downloads[m[2]](m[1]);
			return json(res, 200, { ok: true });
		}
		if (req.method === 'POST' && route === 'downloads/clear') {
			downloads.clearFinished();
			return json(res, 200, { ok: true });
		}
		if (req.method === 'POST' && route === 'books/add') {
			const body = await readJson(req);
			const b = await library.addFile(body.path);
			return json(res, 200, { book: library.describe(b) });
		}
		if (req.method === 'POST' && route === 'books/remove') {
			const body = await readJson(req);
			await library.remove(body.id, !!body.deleteFile);
			return json(res, 200, { ok: true });
		}
		if (req.method === 'POST' && route === 'books/reindex') {
			const body = await readJson(req);
			library.reindex(body.id);
			return json(res, 200, { ok: true });
		}
		if (req.method === 'POST' && route === 'open-folder') {
			const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
			const ok = await new Promise((resolve) => {
				const child = spawn(cmd, [LIB_DIR], { detached: true, stdio: 'ignore' });
				child.on('error', () => resolve(false));
				child.on('spawn', () => resolve(true));
				child.unref();
			});
			return json(res, ok ? 200 : 501, ok ? { ok: true } : { error: 'No file manager available. The library folder is ' + LIB_DIR });
		}
		return json(res, 404, { error: 'Unknown API route' });
	}

	const server = http.createServer(async (req, res) => {
		try {
			// DNS-rebinding guard: only answer to our own host names.
			const host = req.headers.host || '';
			if (host !== UI_HOST && host !== CONTENT_HOST && host !== '[::1]:' + PORT) return send(res, 421, 'Misdirected request');
			const url = new URL(req.url, 'http://' + host);
			const p = url.pathname;
			let m;
			const isContent = p.startsWith('/content/');
			// Each origin serves only its own half; static files and icons serve both.
			if (isContent && host !== CONTENT_HOST) return send(res, 302, '', { Location: CONTENT_ORIGIN + req.url });
			if (!isContent && host !== UI_HOST && !p.startsWith('/static/') && !p.startsWith('/icon/')) {
				if (p.startsWith('/api/')) return json(res, 403, { error: 'Forbidden' });
				return send(res, 302, '', { Location: UI_ORIGIN + req.url });
			}
			if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
			if (p === '/search') return serveStatic(res, 'search.html');
			if (p === '/library') return serveStatic(res, 'library.html');
			if (p.startsWith('/view/')) return serveStatic(res, 'view.html');
			if (p.startsWith('/static/')) return serveStatic(res, p.slice(8));
			if (p === '/favicon.ico') return serveStatic(res, 'favicon.svg');
			if ((m = /^\/api\/(.+)$/.exec(p))) return await api(req, res, m[1], url);
			if ((m = /^\/content\/([^/]+)\/?(.*)$/.exec(p))) return await serveContent(req, res, m[1], m[2]);
			if ((m = /^\/icon\/([^/]+)$/.exec(p))) {
				const b = library.get(m[1]);
				const png = b && (await b.zim.getIllustration());
				if (!png) return send(res, 404, '');
				return send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' });
			}
			send(res, 404, 'Not found');
		} catch (err) {
			console.error('[http]', req.method, req.url, err);
			if (!res.headersSent) json(res, 500, { error: err.message });
			else res.destroy();
		}
	});

	const url = UI_ORIGIN + '/';
	server.on('error', async (err) => {
		if (err.code === 'EADDRINUSE') {
			// Probably xVine already running: hand the user to it instead.
			console.log('xVine already running at ' + url);
			if (!arg('no-open', false)) openBrowser(url);
			process.exit(0);
		}
		throw err;
	});

	await library.init();
	// "localhost" may resolve to ::1 first; answer there too when IPv6 exists.
	const server6 = http.createServer((req, res) => server.emit('request', req, res));
	server6.on('error', () => {});
	server.listen(PORT, HOST, () => {
		server6.listen(PORT, '::1');
		console.log('xVine ' + VERSION + ' — ' + url);
		console.log('Data: ' + DATA);
		console.log('Archives: ' + library.books.size);
		if (!arg('no-open', false)) openBrowser(url);
	});

	const stop = async () => {
		server.close();
		await library.closeAll();
		process.exit(0);
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}

function encodePath(p) {
	return p.split('/').map(encodeURIComponent).join('/');
}

function notFoundPage(book, p) {
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
	return injectFrameScript(
		'<!doctype html><meta charset="utf-8"><title>Not in this archive</title>' +
			'<body style="font:15px/1.6 monospace;background:#000;color:#eee;padding:3rem">' +
			'<p>&gt; <b>' + esc(p) + '</b> is not in <b>' + esc(book.title) + '</b>.</p>' +
			'<p><a style="color:#fff" href="/search?q=' + encodeURIComponent(p.replace(/_/g, ' ')) + '">Search xVine for it</a></p>',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
