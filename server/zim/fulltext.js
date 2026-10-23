'use strict';
/* Full-text search over a ZIM's embedded Xapian index. Mirrors how libzim
   indexes (unaccented, lowercased, Snowball-stemmed terms, CJK n-grams, no
   positions) and how it queries (AND by default), ranked with BM25 using the
   same parameters as Xapian's BM25Weight (k1 = 1, b = 0.5, min normlen 0.5). */

const { GlassDatabase } = require('./xapian');
const porter2 = require('./porter2');
const { LETTER, ALNUM, unaccent } = require('../unicode');

const K1 = 1;
const B = 0.5;
const MIN_NORMLEN = 0.5;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;


/** Words of a query (or title): unaccented, lowercase, CJK split to n-grams. */
function words(text) {
	const out = [];
	const re = new RegExp('[' + ALNUM + ']+(?:[\'’][' + LETTER + ']+)*', 'gu');
	let m;
	const s = unaccent(String(text)).toLowerCase();
	while ((m = re.exec(s))) {
		const w = m[0].replace(/['’]s$/, '').replace(/’/g, "'");
		if (!CJK.test(w)) {
			out.push(w);
			continue;
		}
		// Split mixed runs; CJK runs become bigrams (unigram if alone).
		for (const part of w.split(/([぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+)/u)) {
			if (!part) continue;
			if (!CJK.test(part)) out.push(part);
			else if (part.length === 1) out.push(part);
			else for (let i = 0; i + 1 < part.length; i++) out.push(part.slice(i, i + 2));
		}
	}
	return out;
}

class ZimFulltext {
	/** Open the archive's full-text index, or null if it has none. */
	static async open(zim) {
		const e = await zim.findByPath('X', 'fulltext/xapian');
		if (!e || e.isRedirect) return null;
		const target = await e.resolve();
		const size = await target.getSize();
		if (!size) return null;
		const db = await GlassDatabase.open((off, len) => zim.readBlobRange(target.cluster, target.blob, off, len), size);
		const ft = new ZimFulltext(zim, db);
		ft.language = ((await db.metadata('language')) || '').toLowerCase();
		ft.stemmer = /^(en|eng)(\b|_|-|$)/.test(ft.language) ? porter2.stem : null;
		return ft;
	}

	constructor(zim, db) {
		this.zim = zim;
		this.db = db;
		this.termCache = new Map();
	}

	get docCount() {
		return this.db.doccount;
	}

	stem(w) {
		return this.stemmer && !CJK.test(w) ? this.stemmer(w) : w;
	}

	/** Index term for a query word, falling back to the longest indexed prefix. */
	async resolveTerm(w) {
		if (this.termCache.has(w)) return this.termCache.get(w);
		let found = null;
		for (const t of new Set([this.stem(w), w])) {
			const tf = await this.db.termFreq(t);
			if (tf) {
				found = { term: t, tf };
				break;
			}
		}
		// Languages we have no stemmer for: Snowball stems are nearly always
		// prefixes of the word, so try the longest prefix that is indexed.
		if (!found && !CJK.test(w) && w.length > 4) {
			for (let k = w.length - 1; k >= Math.max(4, Math.ceil(w.length * 0.6)); k--) {
				const tf = await this.db.termFreq(w.slice(0, k));
				if (tf) {
					found = { term: w.slice(0, k), tf };
					break;
				}
			}
		}
		if (this.termCache.size > 5000) this.termCache.clear();
		this.termCache.set(w, found);
		return found;
	}

	idf(tf) {
		const N = this.db.doccount;
		return Math.log(1 + (N - tf + 0.5) / (tf + 0.5));
	}

	/** Per-word document frequencies, for collection-wide IDF across archives. */
	async termStats(query) {
		const out = new Map();
		for (const w of new Set(words(query))) {
			const r = await this.resolveTerm(w);
			out.set(w, r ? r.tf : 0);
		}
		return { N: this.db.doccount, df: out };
	}

	/**
	 * Search. Returns { hits: [{ path, title, score }], total, missing, loose }.
	 * `total` counts every matching document.
	 */
	async search(query, { limit = 20, offset = 0, idf = null } = {}) {
		// `idf(word)` lets a caller searching several archives score them all
		// against shared statistics, so their scores can be merged directly.
		this._idfFor = idf;
		const qwords = [...new Set(words(query))].slice(0, 16);
		const res = { hits: [], total: 0, missing: [], loose: false, terms: [] };
		if (!qwords.length) return res;
		const terms = [];
		for (const w of qwords) {
			const r = await this.resolveTerm(w);
			if (r && !terms.some((t) => t.term === r.term)) terms.push({ ...r, word: w });
			else if (!r) res.missing.push(w);
		}
		res.terms = terms.map((t) => t.term);
		if (!terms.length) return res;

		let scored = await this._and(terms);
		// Natural-language queries ("how do volcanoes erupt"): retry with just
		// the content words before giving up on matching everything.
		const content = terms.filter((t) => t.tf <= this.db.doccount * 0.05);
		if (!scored.length && content.length && content.length < terms.length) {
			scored = await this._and(content);
			res.loose = scored.length > 0;
		}
		if (!scored.length && terms.length > 1) {
			scored = await this._or(terms);
			res.loose = scored.length > 0;
		}
		res.total = scored.length;

		// Rerank the head by how much of the query the title covers, then page.
		const window = Math.min(scored.length, Math.max(60, offset + limit + 20));
		scored.sort((a, b) => b.score - a.score);
		const head = scored.slice(0, window);
		const stems = new Set(terms.map((t) => t.term));
		for (const h of head) {
			const data = await this.db.documentData(h.did);
			h.path = data && /^[A-Z\-]\//.test(data) ? data.slice(2) : data;
			h.ns = data && /^[A-Z\-]\//.test(data) ? data[0] : this.zim.contentNs;
			const e = h.path != null ? await this.zim.findByPath(h.ns, h.path) : null;
			h.title = e ? e.title : h.path;
			const tw = new Set(words(h.title || '').map((w) => this.stem(w)));
			let cover = 0;
			for (const s of stems) if (tw.has(s)) cover++;
			const exactTitle = (h.title || '').toLowerCase() === String(query).trim().toLowerCase();
			h.score *= 1 + (0.6 * cover) / stems.size + (exactTitle ? 1 : 0);
		}
		head.sort((a, b) => b.score - a.score);
		res.hits = head.slice(offset, offset + limit).map((h) => ({ path: h.path, ns: h.ns, title: h.title, score: h.score }));
		return res;
	}

	/** Conjunction: leapfrog from the rarest term, BM25 for every match. */
	async _and(terms) {
		const N = this.db.doccount;
		// Near-universal terms ("the", "of") filter nothing and weigh ~0.
		let use = terms.filter((t) => t.tf <= N * 0.4);
		if (!use.length) use = terms.slice();
		use.sort((a, b) => a.tf - b.tf);
		const cursors = [];
		for (const t of use) {
			const pc = this.db.postings(t.term);
			if (!(await pc.open())) return [];
			cursors.push({ pc, idf: this._idfFor ? this._idfFor(t.word) : this.idf(t.tf) });
		}
		const lead = cursors[0].pc;
		const matches = [];
		const wdfs = [];
		do {
			const did = lead.did;
			let ok = true;
			for (let i = 1; i < cursors.length; i++) {
				if (!(await cursors[i].pc.skipTo(did))) return this._score(matches, wdfs, cursors);
				if (cursors[i].pc.did !== did) {
					ok = false;
					// Jump the lead forward to the blocker.
					if (!(await lead.skipTo(cursors[i].pc.did))) return this._score(matches, wdfs, cursors);
					break;
				}
			}
			if (!ok) continue;
			matches.push(did);
			wdfs.push(cursors.map((c) => c.pc.wdf));
			if (!(await lead.next())) break;
		} while (!lead.atEnd);
		return this._score(matches, wdfs, cursors);
	}

	/** Disjunction for when no document has every term. */
	async _or(terms) {
		const N = this.db.doccount;
		const acc = new Map();
		for (const t of terms) {
			if (t.tf > N * 0.4) continue;
			const pc = this.db.postings(t.term);
			if (!(await pc.open())) continue;
			const idf = this._idfFor ? this._idfFor(t.word) : this.idf(t.tf);
			do {
				const e = acc.get(pc.did);
				if (e) e.push([idf, pc.wdf]);
				else acc.set(pc.did, [[idf, pc.wdf]]);
			} while (await pc.next());
		}
		const dids = [...acc.keys()].sort((a, b) => a - b);
		const out = [];
		const dl = this.db.doclengths();
		await dl.open();
		const avg = this.db.avgLength;
		for (const did of dids) {
			const len = (await dl.skipTo(did)) && dl.did === did ? dl.wdf : avg;
			const kd = K1 * (1 - B + B * Math.max(len / avg, MIN_NORMLEN));
			let s = 0;
			for (const [idf, wdf] of acc.get(did)) s += (idf * (K1 + 1) * wdf) / (kd + wdf);
			// Reward documents matching more of the query.
			out.push({ did, score: s * (0.5 + acc.get(did).length / terms.length) });
		}
		return out;
	}

	async _score(matches, wdfs, cursors) {
		const out = new Array(matches.length);
		const dl = this.db.doclengths();
		await dl.open();
		const avg = this.db.avgLength;
		for (let k = 0; k < matches.length; k++) {
			const did = matches[k];
			const len = (await dl.skipTo(did)) && dl.did === did ? dl.wdf : avg;
			const kd = K1 * (1 - B + B * Math.max(len / avg, MIN_NORMLEN));
			let s = 0;
			for (let i = 0; i < cursors.length; i++) {
				const wdf = wdfs[k][i];
				s += (cursors[i].idf * (K1 + 1) * wdf) / (kd + wdf);
			}
			out[k] = { did, score: s };
		}
		return out;
	}
}

module.exports = { ZimFulltext, words };
