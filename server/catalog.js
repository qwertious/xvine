'use strict';
/* Kiwix OPDS catalog client. Responses are cached on disk so the catalog can
   still be browsed (and installed archives matched to it) while offline. */

const fs = require('fs');
const path = require('path');
const { getText, request } = require('./net');
const { decodeEntities } = require('./text');

const BASE = 'https://opds.library.kiwix.org';

class Catalog {
	constructor(cacheDir, { questUrl = null } = {}) {
		this.cacheDir = cacheDir;
		this.questUrl = questUrl;
		fs.mkdirSync(cacheDir, { recursive: true });
		this.mem = new Map();
	}

	async _fetch(rel, maxAgeMs) {
		const file = path.join(this.cacheDir, rel.replace(/[^a-z0-9]+/gi, '_').slice(0, 180) + '.xml');
		const hit = this.mem.get(rel);
		if (hit && Date.now() - hit.at < maxAgeMs) return { xml: hit.xml, cached: false };
		try {
			const xml = await getText(BASE + rel, { timeout: 15000 });
			this.mem.set(rel, { xml, at: Date.now() });
			fs.writeFile(file, xml, () => {});
			return { xml, cached: false };
		} catch (err) {
			try {
				return { xml: fs.readFileSync(file, 'utf8'), cached: true, error: err.message };
			} catch (e) {
				const e2 = new Error('Catalog unavailable (offline?): ' + err.message);
				e2.offline = true;
				throw e2;
			}
		}
	}

	async entries({ q = '', lang = '', category = '', start = 0, count = 30 } = {}) {
		const p = new URLSearchParams();
		if (q) p.set('q', q);
		if (lang) p.set('lang', lang);
		if (category) p.set('category', category);
		p.set('start', String(start));
		p.set('count', String(count));
		const { xml, cached } = await this._fetch('/catalog/v2/entries?' + p, 30 * 60 * 1000);
		return {
			total: num(tag(xml, 'totalResults')),
			start,
			cached,
			entries: blocks(xml, 'entry').map(parseEntry),
		};
	}

	/* ------------------------------------------------------------- QUEST */

	/**
	 * QUEST packs: XIO's own crawl, exported as ZIMs by quest/xvine_export.py
	 * and listed in a small JSON catalog next to them.
	 */
	async quest({ q = '' } = {}) {
		if (!this.questUrl) throw Object.assign(new Error('No QUEST catalog configured'), { offline: false });
		const file = path.join(this.cacheDir, 'quest-catalog.json');
		let raw;
		let cached = false;
		const hit = this.mem.get('quest');
		if (hit && Date.now() - hit.at < 10 * 60 * 1000) raw = hit.raw;
		else {
			try {
				raw = await getText(this.questUrl, { timeout: 15000 });
				JSON.parse(raw);
				this.mem.set('quest', { raw, at: Date.now() });
				fs.writeFile(file, raw, () => {});
			} catch (err) {
				// Reachable but nothing published yet: an empty catalog, not an error.
				if (/^HTTP 404\b/.test(err.message)) return { total: 0, start: 0, cached: false, source: 'quest', entries: [] };
				try {
					raw = fs.readFileSync(file, 'utf8');
					cached = true;
				} catch (e) {
					throw Object.assign(new Error('QUEST catalog unavailable (offline?): ' + err.message), { offline: true });
				}
			}
		}
		const cat = JSON.parse(raw);
		const ql = String(q).trim().toLowerCase();
		const entries = (cat.entries || [])
			.filter((m) => m && typeof m.file === 'string' && /^[\w.@+-]+\.zim$/.test(m.file))
			.map((m) => ({
				id: String(m.id || m.file),
				source: 'quest',
				name: String(m.name || 'quest_web'),
				flavour: String(m.flavour || ''),
				title: String(m.title || 'QUEST web archive'),
				summary: String(m.summary || ''),
				language: String(m.language || ''),
				category: 'quest',
				tags: [],
				pictures: false,
				articleCount: Number(m.articleCount) || 0,
				siteCount: Number(m.siteCount) || 0,
				size: Number(m.size) || 0,
				file: m.file,
				url: new URL(m.file, this.questUrl).href,
				sha256: String(m.sha256 || ''),
				date: String(m.date || ''),
				icon: '/api/catalog/icon?quest=1',
			}))
			.filter((e) => !ql || (e.title + ' ' + e.summary + ' ' + e.flavour).toLowerCase().includes(ql));
		return { total: entries.length, start: 0, cached, source: 'quest', generated: cat.generated || null, entries };
	}

	async questIcon() {
		const file = path.join(this.cacheDir, 'icons', 'quest.png');
		try {
			return fs.readFileSync(file);
		} catch (e) {
			/* not cached yet */
		}
		const res = await request(new URL('icon.png', this.questUrl).href, { timeout: 15000 });
		const chunks = [];
		for await (const c of res) chunks.push(c);
		if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
		const png = Buffer.concat(chunks);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFile(file, png, () => {});
		return png;
	}

	/** Catalog thumbnail (PNG), fetched once then served from disk. */
	async icon(rel) {
		if (!/^\/catalog\/v2\/illustration\/[0-9a-f-]+\/\?size=\d+$/.test(rel)) throw new Error('Bad icon path');
		const file = path.join(this.cacheDir, 'icons', rel.replace(/[^a-z0-9]+/gi, '_') + '.png');
		try {
			return fs.readFileSync(file);
		} catch (e) {
			/* not cached yet */
		}
		const res = await request(BASE + rel, { timeout: 15000 });
		const chunks = [];
		for await (const c of res) chunks.push(c);
		if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
		const png = Buffer.concat(chunks);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFile(file, png, () => {});
		return png;
	}

	async facets() {
		const [langs, cats] = await Promise.all([
			this._fetch('/catalog/v2/languages', 24 * 3600 * 1000),
			this._fetch('/catalog/v2/categories', 24 * 3600 * 1000),
		]);
		const languages = blocks(langs.xml, 'entry')
			.map((b) => ({ code: tag(b, 'dc:language'), name: text(tag(b, 'title')), count: num(tag(b, 'thr:count')) }))
			.filter((l) => l.code)
			.sort((a, b) => b.count - a.count);
		const categories = blocks(cats.xml, 'entry')
			.map((b) => text(tag(b, 'title')))
			.filter(Boolean)
			.sort();
		return { languages, categories, cached: langs.cached || cats.cached };
	}
}

function parseEntry(b) {
	const acq = /<link[^>]*rel="http:\/\/opds-spec.org\/acquisition\/open-access"[^>]*>/.exec(b);
	const thumb = /<link[^>]*rel="http:\/\/opds-spec.org\/image\/thumbnail"[^>]*href="([^"]+)"/.exec(b);
	const meta4 = acq ? attrOf(acq[0], 'href') : null;
	return {
		id: (tag(b, 'id') || '').replace(/^urn:uuid:/, ''),
		name: text(tag(b, 'name')),
		flavour: text(tag(b, 'flavour')),
		title: text(tag(b, 'title')),
		summary: text(tag(b, 'summary')),
		language: text(tag(b, 'language')),
		category: text(tag(b, 'category')),
		tags: text(tag(b, 'tags')).split(';').filter((t) => t && !t.startsWith('_')),
		pictures: /_pictures:yes/.test(b),
		articleCount: num(tag(b, 'articleCount')),
		mediaCount: num(tag(b, 'mediaCount')),
		size: acq ? num(attrOf(acq[0], 'length')) : 0,
		meta4,
		file: meta4 ? decodeURIComponent(meta4.split('/').pop().replace(/\.meta4$/, '')) : null,
		date: (tag(b, 'dc:issued') || tag(b, 'updated') || '').slice(0, 10),
		// Served through xVine (/api/catalog/icon) so it is cached for offline use.
		icon: thumb ? '/api/catalog/icon?u=' + encodeURIComponent(decodeEntities(thumb[1])) : null,
	};
}

function blocks(xml, name) {
	const re = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'g');
	const out = [];
	let m;
	while ((m = re.exec(xml))) out.push(m[1]);
	return out;
}
function tag(xml, name) {
	const m = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>').exec(xml);
	return m ? m[1] : '';
}
function attrOf(el, name) {
	const m = new RegExp('\\s' + name + '="([^"]*)"').exec(el);
	return m ? decodeEntities(m[1]) : '';
}
function text(s) {
	return decodeEntities(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}
function num(s) {
	const n = parseInt(s, 10);
	return Number.isFinite(n) ? n : 0;
}

module.exports = { Catalog };
