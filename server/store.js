'use strict';
/* The search index database. All SQL lives behind this module so the driver can
   be swapped: desktop uses Node's built-in node:sqlite; Node 18 (Android via
   nodejs-mobile) would use better-sqlite3, which has the same prepare/run/get/
   all shape and bundles its own SQLite with FTS5. */

function openDriver(file) {
	try {
		const { DatabaseSync } = require('node:sqlite');
		return new DatabaseSync(file);
	} catch (e) {
		if (e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && e.code !== 'MODULE_NOT_FOUND') throw e;
	}
	try {
		const Better = require('better-sqlite3');
		return new Better(file);
	} catch (e) {
		return null;
	}
}

const { ALNUM } = require('./unicode');

const WORD = new RegExp('[' + ALNUM + ']+', 'gu');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sources (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	uuid TEXT,
	state TEXT NOT NULL DEFAULT 'pending',
	done INTEGER NOT NULL DEFAULT 0,
	total INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	updated INTEGER
);
CREATE TABLE IF NOT EXISTS docs (
	id INTEGER PRIMARY KEY,
	source TEXT NOT NULL,
	path TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT,
	UNIQUE (source, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
	title, body,
	content = '', contentless_delete = 1,
	tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * Stand-in when no SQLite driver exists (Node 18 on Android without native
 * modules). Archives with an embedded Xapian index don't need xVine's own
 * index at all; others fall back to title search.
 */
class MemoryStore {
	constructor() {
		this.available = false;
		this.rows = new Map();
	}
	source(id) {
		return this.rows.get(id) || null;
	}
	sources() {
		return [...this.rows.values()];
	}
	upsertSource(id, kind, uuid) {
		if (!this.rows.has(id)) this.rows.set(id, { id, kind, uuid, state: 'pending', done: 0, total: 0, error: null, updated: Date.now() });
	}
	setSource(id, fields) {
		const r = this.rows.get(id);
		if (r) Object.assign(r, fields, { updated: Date.now() });
	}
	dropSource(id) {
		this.rows.delete(id);
	}
	clearDocs() {
		return 0;
	}
	addDoc() {
		return false;
	}
	doc() {
		return null;
	}
	search() {
		return [];
	}
}

class Store {
	/** A SQLite-backed store, or a MemoryStore when no driver is available. */
	static open(file) {
		const db = openDriver(file);
		return db ? new Store(db) : new MemoryStore();
	}

	constructor(db) {
		this.available = true;
		this.db = typeof db === 'string' ? openDriver(db) : db;
		this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 15000;');
		this.db.exec(SCHEMA);
		this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		this.q = {};
	}

	stmt(sql) {
		return this.q[sql] || (this.q[sql] = this.db.prepare(sql));
	}

	tx(fn) {
		this.db.exec('BEGIN');
		try {
			const r = fn();
			this.db.exec('COMMIT');
			return r;
		} catch (e) {
			this.db.exec('ROLLBACK');
			throw e;
		}
	}

	/* ------------------------------------------------------------ sources */

	source(id) {
		return this.stmt('SELECT * FROM sources WHERE id = ?').get(id) || null;
	}

	sources() {
		return this.stmt('SELECT * FROM sources').all();
	}

	upsertSource(id, kind, uuid) {
		this.stmt(
			`INSERT INTO sources (id, kind, uuid, state, updated) VALUES (?, ?, ?, 'pending', ?)
			 ON CONFLICT (id) DO UPDATE SET kind = excluded.kind`,
		).run(id, kind, uuid, Date.now());
	}

	setSource(id, fields) {
		const keys = Object.keys(fields);
		const sql = 'UPDATE sources SET ' + keys.map((k) => k + ' = ?').join(', ') + ', updated = ? WHERE id = ?';
		this.db.prepare(sql).run(...keys.map((k) => fields[k]), Date.now(), id);
	}

	dropSource(id) {
		this.tx(() => {
			this.stmt('DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM docs WHERE source = ?)').run(id);
			this.stmt('DELETE FROM docs WHERE source = ?').run(id);
			this.stmt('DELETE FROM sources WHERE id = ?').run(id);
		});
	}

	/** Empty a source's documents but keep its row (for a re-index). */
	clearDocs(id) {
		const n = this.tx(() => {
			this.stmt('DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM docs WHERE source = ?)').run(id);
			return this.stmt('DELETE FROM docs WHERE source = ?').run(id).changes;
		});
		// Give a big index's space back to the disk (SQLite won't on its own).
		if (n > 20000) {
			this.db.exec('VACUUM');
			this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // in WAL mode the shrink lands only at a checkpoint
		}
		return n;
	}

	/* --------------------------------------------------------------- docs */

	addDoc(source, path, title, summary, body) {
		const r = this.stmt(
			`INSERT INTO docs (source, path, title, summary) VALUES (?, ?, ?, ?)
			 ON CONFLICT (source, path) DO NOTHING`,
		).run(source, path, title, summary);
		if (!r.changes) return false;
		this.stmt('INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)').run(r.lastInsertRowid, title, body);
		return true;
	}

	doc(source, path) {
		return this.stmt('SELECT * FROM docs WHERE source = ? AND path = ?').get(source, path) || null;
	}

	/**
	 * Full-text search. `match` is an FTS5 expression built by ftsQuery();
	 * title hits weigh 8x body hits.
	 */
	search(match, { sources = null, limit = 20, offset = 0 } = {}) {
		let sql = `SELECT d.source, d.path, d.title, d.summary, bm25(docs_fts, 8.0, 1.0) AS score
			FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
			WHERE docs_fts MATCH ?`;
		const args = [match];
		if (sources && sources.length) {
			sql += ' AND d.source IN (' + sources.map(() => '?').join(',') + ')';
			args.push(...sources);
		}
		sql += ' ORDER BY score LIMIT ? OFFSET ?';
		args.push(limit, offset);
		return this.db.prepare(sql).all(...args);
	}
}

/** Turn free text into a safe FTS5 expression (every token quoted). */
function ftsQuery(text, mode = 'and') {
	const tokens = String(text)
		.toLowerCase()
		.match(WORD);
	if (!tokens) return null;
	const quoted = tokens.slice(0, 12).map((t) => '"' + t + '"');
	return quoted.join(mode === 'or' ? ' OR ' : ' ');
}

module.exports = { Store, MemoryStore, ftsQuery };
