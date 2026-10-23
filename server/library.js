'use strict';
/* The library: which archives are installed, their open readers, and the
   queue that indexes them. Any .zim dropped into the library folder is picked
   up on start; archives elsewhere on disk can be added by path. */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const { ZimArchive } = require('./zim/reader');
const { ZimFulltext } = require('./zim/fulltext');

class Library extends EventEmitter {
	constructor({ dir, stateFile, store, dbPath, leadChars }) {
		super();
		this.dir = dir;
		this.stateFile = stateFile;
		this.store = store;
		this.dbPath = dbPath;
		this.leadChars = leadChars;
		this.books = new Map(); // id -> book
		this.queue = [];
		this.worker = null;
		this.progress = new Map(); // id -> { phase, done, total }
		this.extra = [];
		try {
			this.extra = JSON.parse(fs.readFileSync(stateFile, 'utf8')).extra || [];
		} catch (e) {
			/* first run */
		}
	}

	_save() {
		fs.writeFileSync(this.stateFile, JSON.stringify({ extra: this.extra }, null, 1));
	}

	async init() {
		fs.mkdirSync(this.dir, { recursive: true });
		const files = fs
			.readdirSync(this.dir)
			.filter((f) => f.toLowerCase().endsWith('.zim'))
			.map((f) => path.join(this.dir, f));
		for (const f of [...files, ...this.extra]) {
			try {
				await this._open(f);
			} catch (err) {
				console.warn('[library] skipping', f, '-', err.message);
			}
		}
		// Index rows for archives that are gone.
		for (const s of this.store.sources()) {
			if (s.kind === 'zim' && !this.books.has(s.id)) this.store.dropSource(s.id);
		}
		for (const b of this.books.values()) this._maybeQueue(b);
	}

	async _open(file) {
		file = path.resolve(file);
		for (const b of this.books.values()) if (b.file === file) return b;
		const zim = await ZimArchive.open(file);
		const meta = {};
		for (const k of ['Name', 'Title', 'Description', 'Language', 'Flavour', 'Date', 'Creator', 'Publisher', 'Tags']) {
			meta[k] = (await zim.getMetadata(k)) || '';
		}
		const base = path.basename(file, path.extname(file));
		// Stable id across updates: name_flavour, not the dated filename, so
		// saved links and citations survive a newer edition replacing this one.
		let id = (meta.Name ? meta.Name + (meta.Flavour ? '_' + meta.Flavour : '') : base.replace(/_\d{4}-\d{2}$/, ''))
			.toLowerCase()
			.replace(/[^a-z0-9_.-]+/g, '-');
		const existing = this.books.get(id);
		if (existing) {
			// Two editions of the same archive: keep the newer.
			if ((existing.date || '') >= (meta.Date || '')) {
				await zim.close();
				return existing;
			}
			await this._close(existing);
		}
		const main = await zim.getMainEntry();
		const st = fs.statSync(file);
		const book = {
			id,
			file,
			zim,
			title: meta.Title || base,
			description: meta.Description,
			language: meta.Language,
			flavour: meta.Flavour,
			name: meta.Name,
			date: meta.Date,
			creator: meta.Creator,
			publisher: meta.Publisher,
			tags: meta.Tags,
			size: st.size,
			uuid: zim.uuid,
			articleCount: zim.articleCount,
			mainPath: main ? zim.urlPathOf(main) : null,
			hasIcon: !!(await zim.getIllustration()),
			// Kiwix archives usually ship a Xapian full-text index: when present,
			// search reads it directly and xVine builds no index of its own.
			fulltext: await ZimFulltext.open(zim).catch((err) => {
				console.warn('[library] embedded index unreadable in', path.basename(file), '-', err.message);
				return null;
			}),
			inLibraryDir: path.dirname(file) === path.resolve(this.dir),
		};
		this.books.set(id, book);
		this.store.upsertSource(id, 'zim', zim.uuid);
		this.emit('change');
		return book;
	}

	async _close(book) {
		this.books.delete(book.id);
		if (this.worker && this.worker.sourceId === book.id) {
			await this.worker.terminate();
			this.worker = null;
		}
		this.queue = this.queue.filter((id) => id !== book.id);
		await book.zim.close();
	}

	/** Add an archive that lives outside the library folder. */
	async addFile(file) {
		file = path.resolve(String(file || ''));
		if (!file.toLowerCase().endsWith('.zim')) throw new Error('Not a .zim file');
		if (!fs.existsSync(file)) throw new Error('File not found: ' + file);
		const book = await this._open(file);
		if (!book.inLibraryDir && !this.extra.includes(file)) {
			this.extra.push(file);
			this._save();
		}
		this._maybeQueue(book);
		return book;
	}

	async remove(id, deleteFile) {
		const book = this.books.get(id);
		if (!book) throw new Error('No such archive');
		await this._close(book);
		this.store.dropSource(id);
		this.progress.delete(id);
		this.extra = this.extra.filter((f) => f !== book.file);
		this._save();
		if (deleteFile) fs.rmSync(book.file, { force: true });
		this.emit('change');
		this._next();
	}

	reindex(id) {
		const book = this.books.get(id);
		if (!book) throw new Error('No such archive');
		if (book.fulltext) return; // nothing to rebuild: the archive's own index is used
		this.store.setSource(id, { state: 'pending', done: 0 });
		this._maybeQueue(book);
	}

	get(id) {
		return this.books.get(id) || null;
	}

	list() {
		return [...this.books.values()].map((b) => this.describe(b));
	}

	describe(b) {
		const s = this.store.source(b.id);
		const p = this.progress.get(b.id);
		return {
			id: b.id,
			title: b.title,
			description: b.description,
			language: b.language,
			flavour: b.flavour,
			name: b.name,
			date: b.date,
			creator: b.creator,
			size: b.size,
			articleCount: b.articleCount,
			mainPath: b.mainPath,
			hasIcon: b.hasIcon,
			file: b.file,
			inLibraryDir: b.inLibraryDir,
			index: {
				state: s ? s.state : 'pending',
				phase: p ? p.phase : null,
				done: p ? p.done : s ? s.done : 0,
				total: p ? p.total : s ? s.total : 0,
				error: s ? s.error : null,
			},
		};
	}

	/* ------------------------------------------------------------ indexing */

	_maybeQueue(book) {
		const s = this.store.source(book.id);
		if (book.fulltext && !book.forceOwnIndex) {
			if (!s || s.state !== 'builtin' || s.uuid !== book.uuid) {
				this.store.clearDocs(book.id); // reclaim any index built earlier
				this.store.setSource(book.id, { state: 'builtin', uuid: book.uuid, done: book.fulltext.docCount, total: book.fulltext.docCount, error: null });
			}
			return;
		}
		if (s && s.state === 'done' && s.uuid === book.uuid) return;
		if (!this.queue.includes(book.id) && !(this.worker && this.worker.sourceId === book.id)) this.queue.push(book.id);
		this._next();
	}

	_next() {
		if (this.worker || !this.queue.length) return;
		if (!this.store.available) {
			// No SQLite here (e.g. Android): archives without a built-in index
			// stay title-searchable only.
			for (const id of this.queue.splice(0)) this.store.setSource(id, { state: 'unavailable' });
			this.emit('change');
			return;
		}
		const id = this.queue.shift();
		const book = this.books.get(id);
		if (!book) return this._next();
		const w = new Worker(path.join(__dirname, 'indexer.js'), {
			workerData: { task: 'index', file: book.file, sourceId: id, dbPath: this.dbPath, leadChars: this.leadChars },
		});
		w.sourceId = id;
		this.worker = w;
		this.progress.set(id, { phase: 'starting', done: 0, total: 0 });
		const finish = () => {
			if (this.worker === w) this.worker = null;
			this.progress.delete(id);
			this.emit('change');
			this._next();
		};
		w.on('message', (m) => {
			if (m.type === 'progress') this.progress.set(id, { phase: m.phase, done: m.done, total: m.total });
			else if (m.type === 'error') {
				this.store.setSource(id, { state: 'error', error: m.message });
				console.warn('[index]', id, m.message);
			} else if (m.type === 'done') console.log('[index]', id, 'done,', m.total, 'articles');
		});
		w.on('error', (err) => {
			this.store.setSource(id, { state: 'error', error: err.message });
			finish();
		});
		w.on('exit', finish);
	}

	async closeAll() {
		if (this.worker) await this.worker.terminate();
		for (const b of this.books.values()) await b.zim.close();
	}
}

module.exports = { Library };
