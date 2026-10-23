'use strict';
/* Unified search across every source. Two signals are merged:
   - title lookups in each archive's own title index (instant, needs no
     indexing, so a freshly added archive is searchable immediately);
   - full-text BM25 hits from xVine's FTS index. */

const { ftsQuery } = require('./store');
const { LETTER } = require('./unicode');
const { extractText, extractDescription, summarize } = require('./text');

const TITLE_START = new RegExp('(^|[\\s(\\-–/])([' + LETTER + '])', 'gu');

function caseVariants(q) {
	const lower = q.toLowerCase();
	const cap = q.charAt(0).toUpperCase() + q.slice(1);
	const title = lower.replace(TITLE_START, (m, a, b) => a + b.toUpperCase());
	const capLower = lower.charAt(0).toUpperCase() + lower.slice(1);
	return [...new Set([q, cap, title, capLower, lower, q.toUpperCase()])];
}

class Search {
	constructor({ library, store }) {
		this.library = library;
		this.store = store;
		this.summaries = new Map();
	}

	_books(sources) {
		const all = [...this.library.books.values()];
		return sources && sources.length ? all.filter((b) => sources.includes(b.id)) : all;
	}

	/** Autocomplete: title prefixes across archives. */
	async suggest(q, { limit = 10, sources = null } = {}) {
		q = String(q || '').trim();
		if (!q) return [];
		const out = [];
		const seen = new Set();
		for (const book of this._books(sources)) {
			for (const v of caseVariants(q)) {
				for (const e of await book.zim.titlesWithPrefix(v, limit)) {
					const target = await e.resolve();
					const key = book.id + '\0' + target.path;
					if (seen.has(key)) continue;
					seen.add(key);
					out.push({
						source: book.id,
						sourceTitle: book.title,
						title: e.title,
						target: target.title !== e.title ? target.title : null,
						path: book.zim.urlPathOf(target),
					});
				}
			}
		}
		const ql = q.toLowerCase();
		out.sort(
			(a, b) =>
				(b.title.toLowerCase() === ql) - (a.title.toLowerCase() === ql) ||
				!!a.target - !!b.target ||
				a.title.length - b.title.length,
		);
		return out.slice(0, limit);
	}

	/** Exact-title matches (case-insensitive), redirects followed. */
	async exact(q, sources) {
		const ql = q.toLowerCase();
		const hits = [];
		const seen = new Set();
		for (const book of this._books(sources)) {
			for (const v of caseVariants(q)) {
				const e = await book.zim.findByPath(book.zim.contentNs, v.replace(/ /g, '_'));
				const cands = e ? [e] : [];
				if (!e) for (const t of await book.zim.titlesWithPrefix(v, 3)) if (t.title.toLowerCase() === ql) cands.push(t);
				for (const c of cands) {
					const target = await c.resolve();
					if (target.isRedirect || !/html/.test(target.mimeType || '')) continue;
					const key = book.id + '\0' + target.path;
					if (seen.has(key)) continue;
					seen.add(key);
					hits.push({ book, entry: target });
				}
			}
		}
		return hits;
	}

	async summaryFor(book, entry) {
		const path = book.zim.urlPathOf(entry);
		const key = book.id + '\0' + path;
		if (this.summaries.has(key)) return this.summaries.get(key);
		const d = this.store.doc(book.id, path);
		let out = d && d.summary;
		if (!out) {
			try {
				const html = (await entry.getData()).toString('utf8');
				out = summarize(extractDescription(html) || extractText(html, 1200), 320);
			} catch (e) {
				out = '';
			}
		}
		if (this.summaries.size > 4000) this.summaries.clear();
		this.summaries.set(key, out);
		return out;
	}

	async search(q, { sources = null, page = 0, perPage = 20 } = {}) {
		q = String(q || '').trim();
		const res = { query: q, best: [], results: [], titles: [], page, more: false, partial: false };
		if (!q) return res;

		if (page === 0) {
			for (const { book, entry } of await this.exact(q, sources)) {
				res.best.push({
					source: book.id,
					sourceTitle: book.title,
					path: book.zim.urlPathOf(entry),
					title: entry.title,
					summary: await this.summaryFor(book, entry),
				});
			}
			res.titles = (await this.suggest(q, { limit: 8, sources })).filter(
				(s) => !res.best.some((b) => b.source === s.source && b.path === s.path),
			);
		}

		// Full-text: archives with an embedded Xapian index are queried directly;
		// the rest (and QUEST pages, AI pages later) go through xVine's FTS index.
		// Xapian sources share collection-wide statistics so their BM25 scores
		// merge directly.
		const books = this._books(sources);
		const want = (page + 1) * perPage + 1;
		const pools = [];
		res.total = 0;
		// Collection-wide IDF: a word that is rare in a tiny archive but common
		// overall must not make that archive's hits outrank everything.
		let N = 0;
		const df = new Map();
		for (const b of books) {
			if (!b.fulltext) continue;
			const st = await b.fulltext.termStats(q);
			N += st.N;
			for (const [w, n] of st.df) df.set(w, (df.get(w) || 0) + n);
		}
		// A word is "missing" only if no archive has it.
		if (df.size) res.missing = [...df].filter(([, n]) => n === 0).map(([w]) => w);
		const idf = (w) => {
			const n = df.get(w) || 0;
			return Math.log(1 + (N - n + 0.5) / (n + 0.5));
		};
		for (const b of books) {
			if (!b.fulltext) continue;
			const r = await b.fulltext.search(q, { limit: want, idf });
			res.total += r.total;
			if (r.loose) res.loose = true;
			if (r.hits.length) {
				pools.push(r.hits.map((h) => ({ source: b.id, sourceTitle: b.title, path: h.path, title: h.title, score: h.score, book: b, ns: h.ns })));
			}
		}
		const ftsBooks = books.filter((b) => !b.fulltext).map((b) => b.id);
		const and = ftsQuery(q, 'and');
		if (and && ftsBooks.length) {
			let rows = this.store.search(and, { sources: ftsBooks, limit: want, offset: 0 });
			if (!rows.length && /\s/.test(q)) {
				rows = this.store.search(ftsQuery(q, 'or'), { sources: ftsBooks, limit: want, offset: 0 });
				if (rows.length) res.loose = true;
			}
			if (rows.length) {
				// SQLite's bm25() is negated and weighs titles 8x; bring it onto
				// roughly the same scale as the Xapian scores.
				pools.push(rows.map((r) => ({ source: r.source, sourceTitle: (this.library.get(r.source) || {}).title || r.source, path: r.path, title: r.title, summary: r.summary, score: -r.score / 3 })));
			}
		}
		const merged = pools.flat().sort((a, b) => b.score - a.score);
		const bestKeys = new Set(res.best.map((b) => b.source + '\0' + b.path));
		const pageRows = merged.filter((r) => !bestKeys.has(r.source + '\0' + r.path)).slice(page * perPage, page * perPage + perPage + 1);
		res.more = pageRows.length > perPage;
		res.results = [];
		for (const r of pageRows.slice(0, perPage)) {
			let summary = r.summary;
			if (summary == null && r.book) {
				const e = await r.book.zim.findByPath(r.ns || r.book.zim.contentNs, r.path);
				summary = e ? await this.summaryFor(r.book, e) : '';
			}
			res.results.push({ source: r.source, sourceTitle: r.sourceTitle, path: r.path, title: r.title, summary });
		}

		res.partial = books.some((b) => {
			if (b.fulltext) return false;
			const s = this.store.source(b.id);
			return !s || s.state !== 'done';
		});
		return res;
	}
}

module.exports = { Search };
