'use strict';
/* Read-only reader for Xapian "glass" single-file databases — the full-text
   index Kiwix embeds in ZIM files (X/fulltext/xapian). Pure JS, random access
   through a read callback, so it works straight out of the ZIM on any Node
   (Android's Node 18 included) with no indexing pass.

   Format notes (xapian-core 1.4, backends/glass):
   - Byte 0: version header ("\x0f\x0dXapian Glass", format, uuid, revision,
     RootInfo × 6 tables, stats). Tables share the file; block n of any table
     is at n × blocksize.
   - B-tree block: REVISION(4) LEVEL(1) MAX_FREE(2) TOTAL_FREE(2) DIR_END(2)
     then a directory of 2-byte item offsets from byte 11. Multi-byte fields
     are big-endian.
   - Leaf item: I(2: flags 0xE0 + size-3) K(1) key [X(2) if not first
     component] tag-chunk. Branch item: block(4) K(1) key X(2).
   - Tags may be split into components and raw-deflate compressed.
   - Postlist table: key = term (sort-preserving), then term+"\0"+did for later
     chunks. "\0\xe0"… is the document-length list, "\0\xc0"+name metadata.
     First chunk: termfreq, collfreq, firstdid-1; every chunk: last flag
     ('0'/'1'), lastdid-firstdid, wdf, then (did gap-1, wdf)*. */

const zlib = require('zlib');

const MAGIC = Buffer.from('\x0f\x0dXapian Glass', 'latin1');
const T = { POSTLIST: 0, DOCDATA: 1, TERMLIST: 2, POSITION: 3, SPELLING: 4, SYNONYM: 5 };
const DIR_START = 11;
const DOCLEN_KEY = Buffer.from([0x00, 0xe0]);
const META_KEY = Buffer.from([0x00, 0xc0]);

/* ----------------------------------------------------------------- packing */

class Reader {
	constructor(buf, pos = 0, end = buf.length) {
		this.b = buf;
		this.p = pos;
		this.end = end;
	}
	get done() {
		return this.p >= this.end;
	}
	uint() {
		let v = 0;
		let mul = 1;
		for (;;) {
			if (this.p >= this.end) throw new Error('xapian: truncated integer');
			const c = this.b[this.p++];
			v += (c & 0x7f) * mul;
			if (c < 128) return v;
			mul *= 128;
		}
	}
	bool() {
		const c = this.b[this.p++] - 48;
		if (c !== 0 && c !== 1) throw new Error('xapian: bad bool');
		return c === 1;
	}
	string() {
		const n = this.uint();
		const s = this.b.subarray(this.p, this.p + n);
		this.p += n;
		return s;
	}
}

/** pack_uint_preserving_sort (docids in keys). */
function sortableUint(v) {
	if (v < 0x8000) return Buffer.from([v >>> 8, v & 0xff]);
	const len = Math.floor((37 - Math.clz32(v)) / 7);
	const out = Buffer.alloc(len);
	let x = v;
	for (let i = 1; i < len; i++) {
		out[len - i] = x & 0xff;
		x = Math.floor(x / 256);
	}
	out[0] = (x | (0xff << (10 - len))) & 0xff;
	return out;
}

function readSortableUint(buf, pos) {
	const lb = buf[pos];
	if (lb < 0x80) return { value: (lb << 8) | buf[pos + 1], next: pos + 2 };
	let len = 2;
	for (let m = 0x40; lb & m; m >>= 1) len++;
	let r = lb & ~(0xff << (9 - len)) & 0xff;
	for (let i = 1; i <= len; i++) r = r * 256 + buf[pos + i];
	return { value: r, next: pos + 1 + len };
}

/** Term part of a postlist key: '\0' escaped as '\0\xff'. */
function escapeTerm(term) {
	const b = Buffer.isBuffer(term) ? term : Buffer.from(term, 'utf8');
	if (b.indexOf(0) < 0) return b;
	const parts = [];
	let s = 0;
	for (let i = 0; i < b.length; i++) {
		if (b[i] === 0) {
			parts.push(b.subarray(s, i + 1), Buffer.from([0xff]));
			s = i + 1;
		}
	}
	parts.push(b.subarray(s));
	return Buffer.concat(parts);
}

function postKey(term) {
	return term.length ? escapeTerm(term) : DOCLEN_KEY;
}

function postChunkKey(term, did) {
	return term.length
		? Buffer.concat([escapeTerm(term), Buffer.from([0]), sortableUint(did)])
		: Buffer.concat([DOCLEN_KEY, sortableUint(did)]);
}

/* ------------------------------------------------------------------ B-tree */

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

/** Compare (key, component) against an item's key/component. */
function cmpKey(aKey, aComp, bKey, bComp) {
	const c = Buffer.compare(aKey, bKey);
	return c !== 0 ? c : aComp - bComp;
}

function leafItem(p, c) {
	const o = be16(p, c);
	const first = (p[o] & 0x20) !== 0;
	const last = (p[o] & 0x40) !== 0;
	const compressed = (p[o] & 0x80) !== 0;
	const size = (be16(p, o) & 0x1fff) + 3;
	const kl = p[o + 2];
	const key = p.subarray(o + 3, o + 3 + kl);
	const comp = first ? 1 : be16(p, o + 3 + kl);
	const cd = 3 + kl + (first ? 0 : 2);
	return { key, comp, last, compressed, chunk: p.subarray(o + cd, o + size) };
}

function branchItem(p, c) {
	const o = be16(p, c);
	const kl = p[o + 4];
	return { block: be32(p, o), key: p.subarray(o + 5, o + 5 + kl), comp: be16(p, o + 5 + kl) };
}

class Table {
	constructor(db, info) {
		this.db = db;
		Object.assign(this, info);
	}

	/** Cursor at the last item <= (key, comp); `exact` if equal. */
	async seek(key, comp = 1) {
		const path = [];
		if (this.rootIsFake || this.numEntries === 0) return { path, empty: true, exact: false };
		let n = this.root;
		for (let lvl = this.level; lvl > 0; lvl--) {
			const p = await this.db.block(n);
			let i = DIR_START;
			let j = be16(p, 9);
			while (j - i > 2) {
				const k = i + Math.floor((j - i) / 4) * 2;
				const it = branchItem(p, k);
				const r = cmpKey(key, comp, it.key, it.comp);
				if (r < 0) j = k;
				else {
					i = k;
					if (r === 0) break;
				}
			}
			path[lvl] = { n, p, c: i };
			n = branchItem(p, i).block;
		}
		const p = await this.db.block(n);
		let i = DIR_START - 2;
		let j = be16(p, 9);
		let exact = false;
		while (j - i > 2) {
			const k = i + Math.floor((j - i) / 4) * 2;
			const it = leafItem(p, k);
			const r = cmpKey(key, comp, it.key, it.comp);
			if (r < 0) j = k;
			else {
				i = k;
				if (r === 0) {
					exact = true;
					break;
				}
			}
		}
		path[0] = { n, p, c: i };
		return { path, exact, empty: false };
	}

	/** Advance to the next leaf item; false at the end of the table. */
	async next(cur) {
		if (cur.empty) return false;
		const leaf = cur.path[0];
		leaf.c += 2;
		if (leaf.c < be16(leaf.p, 9)) return true;
		let lvl = 1;
		while (lvl <= this.level) {
			const b = cur.path[lvl];
			b.c += 2;
			if (b.c < be16(b.p, 9)) break;
			lvl++;
		}
		if (lvl > this.level) {
			leaf.c = be16(leaf.p, 9); // stay past the end
			return false;
		}
		for (; lvl > 0; lvl--) {
			const n = branchItem(cur.path[lvl].p, cur.path[lvl].c).block;
			const p = await this.db.block(n);
			cur.path[lvl - 1] = { n, p, c: DIR_START };
		}
		return true;
	}

	/** Step back one leaf item; false before the start of the table. */
	async prev(cur) {
		if (cur.empty) return false;
		const leaf = cur.path[0];
		leaf.c -= 2;
		if (leaf.c >= DIR_START) return true;
		let lvl = 1;
		while (lvl <= this.level) {
			const b = cur.path[lvl];
			b.c -= 2;
			if (b.c >= DIR_START) break;
			lvl++;
		}
		if (lvl > this.level) {
			leaf.c = DIR_START - 2;
			return false;
		}
		for (; lvl > 0; lvl--) {
			const n = branchItem(cur.path[lvl].p, cur.path[lvl].c).block;
			const p = await this.db.block(n);
			cur.path[lvl - 1] = { n, p, c: be16(p, 9) - 2 };
		}
		return true;
	}

	item(cur) {
		const leaf = cur.path[0];
		if (cur.empty || leaf.c < DIR_START || leaf.c >= be16(leaf.p, 9)) return null;
		return leafItem(leaf.p, leaf.c);
	}

	/** Read the whole tag starting at the cursor (which must be a first component). */
	async readTag(cur) {
		let it = this.item(cur);
		const compressed = it.compressed;
		const parts = [it.chunk];
		while (!it.last) {
			if (!(await this.next(cur))) throw new Error('xapian: tag continues past end of table');
			it = this.item(cur);
			parts.push(it.chunk);
		}
		const raw = parts.length === 1 ? parts[0] : Buffer.concat(parts);
		return compressed ? zlib.inflateRawSync(raw) : Buffer.from(raw);
	}

	/** Tag for an exact key, or null. */
	async get(key) {
		const cur = await this.seek(key, 1);
		if (!cur.exact) return null;
		return this.readTag(cur);
	}

	/** Position on the first component of the entry at or before `key`. */
	async seekEntry(key) {
		let cur = await this.seek(key, 1);
		// Branch keys are truncated separators, so the target can fall just
		// before a leaf's first item: the entry we want ends the previous leaf.
		if (!cur.empty && cur.path[0].c < DIR_START) await this.prev(cur);
		const it = this.item(cur);
		if (it && it.comp !== 1) cur = await this.seek(Buffer.from(it.key), 1);
		return cur;
	}
}

/* --------------------------------------------------------------- postlists */

/** A decoded chunk: parallel docid / wdf arrays. */
function decodeChunk(tag, firstDid, isFirst) {
	const r = new Reader(tag);
	let termfreq = 0;
	let collfreq = 0;
	let did = firstDid;
	if (isFirst) {
		termfreq = r.uint();
		collfreq = r.uint();
		did = r.uint() + 1;
	}
	const last = r.bool();
	const lastDid = did + r.uint();
	const dids = [did];
	const wdfs = [r.uint()];
	while (!r.done) {
		did += r.uint() + 1;
		dids.push(did);
		wdfs.push(r.uint());
	}
	return { termfreq, collfreq, last, firstDid: dids[0], lastDid, dids, wdfs };
}

class PostingCursor {
	constructor(db, term) {
		this.db = db;
		this.term = Buffer.from(term, 'utf8');
		this.table = db.tables[T.POSTLIST];
		this.chunk = null;
		this.i = 0;
		this.cur = null;
		this.atEnd = false;
		this.termfreq = 0;
	}

	/** Load the first chunk; false if the term is absent. */
	async open() {
		this.cur = await this.table.seek(postKey(this.term), 1);
		if (!this.cur.exact) {
			this.atEnd = true;
			return false;
		}
		this.chunk = decodeChunk(await this.table.readTag(this.cur), 0, true);
		this.termfreq = this.chunk.termfreq;
		this.i = 0;
		return true;
	}

	get did() {
		return this.chunk.dids[this.i];
	}
	get wdf() {
		return this.chunk.wdfs[this.i];
	}

	_keyDid(key) {
		const prefix = postKey(this.term);
		const sep = this.term.length ? 1 : 0;
		if (key.length < prefix.length + sep + 2 || key.compare(prefix, 0, prefix.length, 0, prefix.length) !== 0) return -1;
		if (sep && key[prefix.length] !== 0) return -1;
		return readSortableUint(key, prefix.length + sep).value;
	}

	async _nextChunk() {
		if (this.chunk.last || !(await this.table.next(this.cur))) {
			this.atEnd = true;
			return false;
		}
		const it = this.table.item(this.cur);
		const first = this._keyDid(it.key);
		if (first < 0) {
			this.atEnd = true;
			return false;
		}
		this.chunk = decodeChunk(await this.table.readTag(this.cur), first, false);
		this.i = 0;
		return true;
	}

	async next() {
		if (this.atEnd) return false;
		if (++this.i < this.chunk.dids.length) return true;
		return this._nextChunk();
	}

	/** Move to the first posting with docid >= target. */
	async skipTo(target) {
		if (this.atEnd) return false;
		if (this.did >= target) return true;
		if (target > this.chunk.lastDid) {
			if (this.chunk.last) {
				this.atEnd = true;
				return false;
			}
			// Jump straight to the chunk that could hold `target`.
			this.cur = await this.table.seekEntry(postChunkKey(this.term, target));
			const it = this.table.item(this.cur);
			const first = it ? this._keyDid(it.key) : -1;
			const tag = await this.table.readTag(this.cur);
			this.chunk = first < 0 ? decodeChunk(tag, 0, true) : decodeChunk(tag, first, false);
			this.i = 0;
			if (target > this.chunk.lastDid) return (await this._nextChunk()) && this.skipTo(target);
		}
		const d = this.chunk.dids;
		let lo = this.i;
		let hi = d.length - 1;
		while (lo < hi) {
			const m = (lo + hi) >>> 1;
			if (d[m] < target) lo = m + 1;
			else hi = m;
		}
		this.i = lo;
		if (d[lo] < target) return (await this._nextChunk()) && this.skipTo(target);
		return true;
	}
}

/* ---------------------------------------------------------------- database */

class GlassDatabase {
	/**
	 * @param read async (offset, length) => Buffer, relative to the DB start
	 * @param size total bytes
	 */
	static async open(read, size, opts = {}) {
		const db = new GlassDatabase(read, size, opts);
		await db._init();
		return db;
	}

	constructor(read, size, opts) {
		this.read = read;
		this.size = size;
		this.cache = new Map();
		this.cacheMax = opts.cacheBlocks || 2048;
		this.metaCache = new Map();
	}

	async _init() {
		const h = await this.read(0, Math.min(this.size, 1024));
		if (h.compare(MAGIC, 0, MAGIC.length, 0, MAGIC.length) !== 0) throw new Error('Not a Xapian glass database');
		this.format = be16(h, 14);
		const r = new Reader(h, 16 + 16);
		this.revision = r.uint();
		this.tables = [];
		for (let t = 0; t < 6; t++) {
			const root = r.uint();
			const val = r.uint();
			const numEntries = r.uint();
			const bs = r.uint() << 11;
			const compressMin = r.uint();
			r.string(); // freelist
			this.tables.push(
				new Table(this, { root, level: val >> 2, rootIsFake: (val & 1) !== 0, numEntries, blocksize: bs, compressMin }),
			);
		}
		this.blocksize = this.tables[T.POSTLIST].blocksize;
		this.doccount = r.uint();
		this.lastDocid = r.uint() + this.doccount;
		this.doclenLower = r.uint();
		this.wdfUpper = r.uint();
		this.doclenUpper = r.uint() + this.wdfUpper;
		r.uint(); // oldest changeset
		this.totalDoclen = r.uint();
		this.avgLength = this.doccount ? this.totalDoclen / this.doccount : 1;
	}

	async block(n) {
		let b = this.cache.get(n);
		if (b) {
			this.cache.delete(n);
			this.cache.set(n, b);
			return b;
		}
		b = await this.read(n * this.blocksize, this.blocksize);
		if (b.length !== this.blocksize) throw new Error('xapian: short block read ' + n);
		this.cache.set(n, b);
		if (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value);
		return b;
	}

	async metadata(name) {
		if (this.metaCache.has(name)) return this.metaCache.get(name);
		const tag = await this.tables[T.POSTLIST].get(Buffer.concat([META_KEY, Buffer.from(name, 'utf8')]));
		const v = tag ? tag.toString('utf8') : null;
		this.metaCache.set(name, v);
		return v;
	}

	async documentData(did) {
		const tag = await this.tables[T.DOCDATA].get(sortableUint(did));
		return tag ? tag.toString('utf8') : null;
	}

	async termFreq(term) {
		const pc = new PostingCursor(this, term);
		return (await pc.open()) ? pc.termfreq : 0;
	}

	postings(term) {
		return new PostingCursor(this, term);
	}

	/** Terms in the postlist table starting with `prefix` (sorted). */
	async termsWithPrefix(prefix, limit = 50) {
		const t = this.tables[T.POSTLIST];
		const p = escapeTerm(prefix);
		const cur = await t.seek(p, 1);
		const out = [];
		let it = t.item(cur);
		if (!it || Buffer.compare(it.key, p) < 0) {
			if (!(await t.next(cur))) return out;
			it = t.item(cur);
		}
		while (it && out.length < limit) {
			if (it.key.length < p.length || it.key.compare(p, 0, p.length, 0, p.length) !== 0) break;
			if (it.comp === 1 && it.key.indexOf(0) < 0) out.push(it.key.toString('utf8'));
			if (!(await t.next(cur))) break;
			it = t.item(cur);
		}
		return out;
	}

	doclengths() {
		return new PostingCursor(this, '');
	}
}

module.exports = { GlassDatabase, sortableUint, readSortableUint, T };
