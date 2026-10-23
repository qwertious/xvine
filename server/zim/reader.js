'use strict';
/* ZIM archive reader (openZIM format, major version 5/6, old and new namespace
   schemes). Pure JS, random access, nothing loaded wholesale — a 120 GB
   Wikipedia opens instantly and costs a few MB of cache.

   Layout reminders:
     header (80 bytes) → mime list, path pointer list (u64 per entry, sorted by
     namespace+path), cluster pointer list (u64 per cluster), title listing
     (u32 entry indices sorted by namespace+title).
   A cluster is one compression byte followed by an offset table and blobs. */

const fs = require('fs');
const { decompress } = require('./codecs');

const MAGIC = 0x044d495a;
const NONE32 = 0xffffffff;
const REDIRECT = 0xffff;
const LINKTARGET = 0xfffe;
const DELETED = 0xfffd;

/* ------------------------------------------------------------------ cache */

class LRU {
	constructor(maxCost) {
		this.max = maxCost;
		this.cost = 0;
		this.map = new Map();
	}
	get(key) {
		const hit = this.map.get(key);
		if (!hit) return undefined;
		this.map.delete(key);
		this.map.set(key, hit);
		return hit.value;
	}
	set(key, value, cost) {
		const old = this.map.get(key);
		if (old) {
			this.cost -= old.cost;
			this.map.delete(key);
		}
		this.map.set(key, { value, cost });
		this.cost += cost;
		while (this.cost > this.max && this.map.size > 1) {
			const [k, v] = this.map.entries().next().value;
			this.map.delete(k);
			this.cost -= v.cost;
		}
	}
	clear() {
		this.map.clear();
		this.cost = 0;
	}
}

/* ------------------------------------------------------------------ entry */

class Entry {
	constructor(archive, index, fields) {
		this.archive = archive;
		this.index = index;
		Object.assign(this, fields);
	}
	get isRedirect() {
		return this.mimeIndex === REDIRECT;
	}
	get mimeType() {
		if (this.mimeIndex >= LINKTARGET) return null;
		return this.archive.mimeTypes[this.mimeIndex] || 'application/octet-stream';
	}
	/** The entry a redirect chain ends on (or this entry). */
	async resolve(maxHops = 50) {
		let e = this;
		while (e.isRedirect && maxHops-- > 0) e = await this.archive.entryAt(e.redirectIndex);
		return e;
	}
	async getData() {
		const e = await this.resolve();
		if (e.isRedirect || e.mimeIndex >= LINKTARGET) return Buffer.alloc(0);
		return this.archive.readBlob(e.cluster, e.blob);
	}
	async getSize() {
		const e = await this.resolve();
		if (e.isRedirect || e.mimeIndex >= LINKTARGET) return 0;
		return this.archive.blobSize(e.cluster, e.blob);
	}
}

/* ---------------------------------------------------------------- archive */

class ZimArchive {
	static async open(file, opts = {}) {
		const a = new ZimArchive(file, opts);
		await a._init();
		return a;
	}

	constructor(file, opts) {
		this.file = file;
		this.fh = null;
		this.direntCache = new LRU(opts.direntCacheEntries || 40000);
		this.clusterCache = new LRU(opts.clusterCacheBytes || 48 * 1024 * 1024);
		this.ptrCache = new LRU(8192); // 4 KB pages of the path pointer list
		this.titleListing = null; // { cluster, blob, count } or { offset, count }
		this.titleListingBuf = null;
	}

	async _init() {
		this.fh = await fs.promises.open(this.file, 'r');
		const st = await this.fh.stat();
		this.size = st.size;
		const h = await this._read(0, 80);
		if (h.readUInt32LE(0) !== MAGIC) throw new Error('Not a ZIM file: ' + this.file);
		this.majorVersion = h.readUInt16LE(4);
		this.minorVersion = h.readUInt16LE(6);
		this.uuid = h.subarray(8, 24).toString('hex');
		this.entryCount = h.readUInt32LE(24);
		this.clusterCount = h.readUInt32LE(28);
		this.pathPtrPos = u64(h, 32);
		this.titlePtrPos = u64(h, 40);
		this.clusterPtrPos = u64(h, 48);
		this.mimeListPos = u64(h, 56);
		this.mainPageIndex = h.readUInt32LE(64);
		this.checksumPos = u64(h, 72);
		if (this.majorVersion !== 5 && this.majorVersion !== 6) {
			throw new Error('Unsupported ZIM major version ' + this.majorVersion);
		}
		this.newScheme = this.majorVersion === 6 && this.minorVersion >= 1;
		this.contentNs = this.newScheme ? 'C' : 'A';

		// Mime list: NUL-terminated strings ending with an empty one.
		const mimeEnd = Math.min(this.pathPtrPos, this.mimeListPos + 64 * 1024);
		const mb = await this._read(this.mimeListPos, Math.max(0, mimeEnd - this.mimeListPos));
		this.mimeTypes = [];
		let p = 0;
		while (p < mb.length) {
			const z = mb.indexOf(0, p);
			if (z < 0 || z === p) break;
			this.mimeTypes.push(mb.toString('utf8', p, z));
			p = z + 1;
		}

		// Cluster end offsets: a cluster ends where the next one starts.
		await this._initTitleListing();
		this.metadata = {};
	}

	async close() {
		if (this.fh) await this.fh.close();
		this.fh = null;
		this.direntCache.clear();
		this.clusterCache.clear();
	}

	async _read(pos, len) {
		const buf = Buffer.allocUnsafe(len);
		let off = 0;
		while (off < len) {
			const { bytesRead } = await this.fh.read(buf, off, len - off, pos + off);
			if (bytesRead === 0) break;
			off += bytesRead;
		}
		return off === len ? buf : buf.subarray(0, off);
	}

	/* ------------------------------------------------------------ pointers */

	async _pathPtr(i) {
		const PAGE = 512; // pointers per cached page
		const page = Math.floor(i / PAGE);
		let buf = this.ptrCache.get(page);
		if (!buf) {
			const first = page * PAGE;
			const n = Math.min(PAGE, this.entryCount - first);
			buf = await this._read(this.pathPtrPos + first * 8, n * 8);
			this.ptrCache.set(page, buf, 1);
		}
		return u64(buf, (i % PAGE) * 8);
	}

	async _clusterPtr(c) {
		const b = await this._read(this.clusterPtrPos + c * 8, 16);
		const start = u64(b, 0);
		let end;
		if (c + 1 < this.clusterCount) end = u64(b, 8);
		else end = this.checksumPos > start && this.checksumPos <= this.size ? this.checksumPos : this.size;
		if (end <= start) end = this.size;
		return { start, end };
	}

	/* ------------------------------------------------------------- dirents */

	async entryAt(index) {
		if (index < 0 || index >= this.entryCount) throw new RangeError('Entry index out of range: ' + index);
		const hit = this.direntCache.get(index);
		if (hit) return hit;
		const pos = await this._pathPtr(index);
		let len = 256;
		let buf;
		for (;;) {
			buf = await this._read(pos, len);
			const parsed = this._parseDirent(buf);
			if (parsed) {
				const e = new Entry(this, index, parsed);
				this.direntCache.set(index, e, 1);
				return e;
			}
			if (buf.length < len) throw new Error('Truncated directory entry ' + index);
			len *= 4;
		}
	}

	_parseDirent(buf) {
		if (buf.length < 12) return null;
		const mimeIndex = buf.readUInt16LE(0);
		const paramLen = buf.readUInt8(2);
		const namespace = String.fromCharCode(buf.readUInt8(3));
		let p = 8;
		const f = { mimeIndex, namespace };
		if (mimeIndex === REDIRECT) {
			f.redirectIndex = buf.readUInt32LE(p);
			p += 4;
		} else if (mimeIndex === LINKTARGET || mimeIndex === DELETED) {
			// no cluster/blob fields
		} else {
			if (buf.length < 16) return null;
			f.cluster = buf.readUInt32LE(p);
			f.blob = buf.readUInt32LE(p + 4);
			p += 8;
		}
		const z1 = buf.indexOf(0, p);
		if (z1 < 0) return null;
		const z2 = buf.indexOf(0, z1 + 1);
		if (z2 < 0 || z2 + 1 + paramLen > buf.length) return null;
		f.pathBytes = buf.subarray(p, z1);
		f.path = f.pathBytes.toString('utf8');
		f.title = z2 > z1 + 1 ? buf.toString('utf8', z1 + 1, z2) : f.path;
		f.pathBytes = Buffer.from(f.pathBytes); // detach from the read buffer
		return f;
	}

	/** Binary search the path pointer list. */
	async findByPath(ns, path) {
		const key = Buffer.from(ns + path, 'utf8');
		let lo = 0;
		let hi = this.entryCount - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const e = await this.entryAt(mid);
			const c = Buffer.compare(Buffer.concat([Buffer.from(e.namespace), e.pathBytes]), key);
			if (c === 0) return e;
			if (c < 0) lo = mid + 1;
			else hi = mid - 1;
		}
		return null;
	}

	/* ------------------------------------------------------------ clusters */

	async _clusterInfo(c) {
		const key = 'i' + c;
		let info = this.clusterCache.get(key);
		if (info) return info;
		const { start, end } = await this._clusterPtr(c);
		const head = await this._read(start, 1);
		const kind = head[0] & 0x0f;
		const extended = (head[0] & 0x10) !== 0;
		info = { start, end, kind, extended, offSize: extended ? 8 : 4 };
		this.clusterCache.set(key, info, 64);
		return info;
	}

	/** Decompressed body (offset table + blobs) of a compressed cluster. */
	async _clusterBody(c, info) {
		const key = 'b' + c;
		let body = this.clusterCache.get(key);
		if (body) return body;
		const raw = await this._read(info.start + 1, info.end - info.start - 1);
		body = decompress(info.kind, raw);
		this.clusterCache.set(key, body, body.length);
		return body;
	}

	async _blobBounds(c, b) {
		const info = await this._clusterInfo(c);
		const os = info.offSize;
		if (info.kind > 1) {
			const body = await this._clusterBody(c, info);
			const s = os === 8 ? u64(body, b * 8) : body.readUInt32LE(b * 4);
			const e = os === 8 ? u64(body, (b + 1) * 8) : body.readUInt32LE((b + 1) * 4);
			return { info, body, s, e };
		}
		// Uncompressed: read just the two offsets we need, then the blob itself.
		const ob = await this._read(info.start + 1 + b * os, os * 2);
		const s = os === 8 ? u64(ob, 0) : ob.readUInt32LE(0);
		const e = os === 8 ? u64(ob, 8) : ob.readUInt32LE(os);
		return { info, body: null, s, e };
	}

	async readBlob(c, b) {
		const { info, body, s, e } = await this._blobBounds(c, b);
		if (body) return body.subarray(s, e);
		return this._read(info.start + 1 + s, e - s);
	}

	/** A byte range inside a blob — lets big uncompressed media stream. */
	async readBlobRange(c, b, from, len) {
		const { info, body, s, e } = await this._blobBounds(c, b);
		const a = Math.min(e, s + from);
		const z = Math.min(e, a + len);
		if (body) return body.subarray(a, z);
		return this._read(info.start + 1 + a, z - a);
	}

	async blobSize(c, b) {
		const { s, e } = await this._blobBounds(c, b);
		return e - s;
	}

	/* -------------------------------------------------------- title listing */

	async _initTitleListing() {
		if (this.newScheme) {
			for (const name of ['listing/titleOrdered/v1', 'listing/titleOrdered/v0']) {
				const e = await this.findByPath('X', name);
				if (e && !e.isRedirect) {
					const size = await this.blobSize(e.cluster, e.blob);
					this.titleListing = { cluster: e.cluster, blob: e.blob, count: size / 4, frontOnly: name.endsWith('v1') };
					return;
				}
			}
		}
		if (this.titlePtrPos > 0 && this.titlePtrPos < this.size) {
			this.titleListing = { offset: this.titlePtrPos, count: this.entryCount, frontOnly: false };
		}
	}

	get articleCount() {
		return this.titleListing && this.titleListing.frontOnly ? this.titleListing.count : null;
	}

	async _titleIndexAt(i) {
		const t = this.titleListing;
		if (t.offset !== undefined) {
			const PAGE = 1024;
			const page = Math.floor(i / PAGE);
			const key = 't' + page;
			let buf = this.ptrCache.get(key);
			if (!buf) {
				const n = Math.min(PAGE, t.count - page * PAGE);
				buf = await this._read(t.offset + page * PAGE * 4, n * 4);
				this.ptrCache.set(key, buf, 1);
			}
			return buf.readUInt32LE((i % PAGE) * 4);
		}
		const PAGE = 1024;
		const page = Math.floor(i / PAGE);
		const key = 'v' + page;
		let buf = this.ptrCache.get(key);
		if (!buf) {
			const n = Math.min(PAGE, t.count - page * PAGE);
			buf = await this.readBlobRange(t.cluster, t.blob, page * PAGE * 4, n * 4);
			this.ptrCache.set(key, Buffer.from(buf), 1);
		}
		return buf.readUInt32LE((i % PAGE) * 4);
	}

	/** Entry indices of front articles (or every entry, for old files). */
	async *titleOrderedIndices() {
		if (!this.titleListing) return;
		for (let i = 0; i < this.titleListing.count; i++) yield await this._titleIndexAt(i);
	}

	/** Articles whose title starts with `prefix` (byte-exact, i.e. case-sensitive). */
	async titlesWithPrefix(prefix, limit = 10) {
		if (!this.titleListing || !prefix) return [];
		const ns = this.contentNs;
		const key = Buffer.from(ns + prefix, 'utf8');
		const keyOf = (e) => Buffer.from(e.namespace + e.title, 'utf8');
		let lo = 0;
		let hi = this.titleListing.count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const e = await this.entryAt(await this._titleIndexAt(mid));
			if (Buffer.compare(keyOf(e), key) < 0) lo = mid + 1;
			else hi = mid;
		}
		const out = [];
		for (let i = lo; i < this.titleListing.count && out.length < limit; i++) {
			const e = await this.entryAt(await this._titleIndexAt(i));
			const k = keyOf(e);
			if (k.length < key.length || k.compare(key, 0, key.length, 0, key.length) !== 0) break;
			if (e.namespace !== ns) continue;
			if (!this.titleListing.frontOnly && (e.isRedirect || !/html/.test(e.mimeType || ''))) continue;
			out.push(e);
		}
		return out;
	}

	/* ------------------------------------------------------------- helpers */

	async getMetadata(name) {
		if (name in this.metadata) return this.metadata[name];
		const e = await this.findByPath('M', name);
		let v = null;
		if (e && !e.isRedirect) v = (await e.getData()).toString('utf8');
		this.metadata[name] = v;
		return v;
	}

	async getIllustration() {
		for (const n of ['Illustration_48x48@1', 'Illustration_96x96@1']) {
			const e = await this.findByPath('M', n);
			if (e) return e.getData();
		}
		const e = await this.findByPath('-', 'favicon');
		return e ? e.getData() : null;
	}

	async getMainEntry() {
		if (this.newScheme) {
			const w = await this.findByPath('W', 'mainPage');
			if (w) return w.resolve();
		}
		if (this.mainPageIndex !== NONE32 && this.mainPageIndex < this.entryCount) {
			return (await this.entryAt(this.mainPageIndex)).resolve();
		}
		return null;
	}

	/** Map a URL path inside the archive to (namespace, path). */
	locate(urlPath) {
		if (this.newScheme) return { ns: 'C', path: urlPath };
		const m = /^([A-Z\-])\/(.*)$/.exec(urlPath);
		return m ? { ns: m[1], path: m[2] } : { ns: 'A', path: urlPath };
	}

	/** Inverse of locate(): the URL path an entry is served at. */
	urlPathOf(entry) {
		return this.newScheme ? entry.path : entry.namespace + '/' + entry.path;
	}
}

function u64(buf, off) {
	const lo = buf.readUInt32LE(off);
	const hi = buf.readUInt32LE(off + 4);
	if (hi === 0xffffffff && lo === 0xffffffff) return -1;
	return hi * 0x100000000 + lo;
}

module.exports = { ZimArchive, Entry };
