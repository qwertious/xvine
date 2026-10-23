'use strict';
/* Plain-text extraction from archive HTML — fast, regex-level, good enough for
   indexing and summaries. Not a sanitizer: output is text, never re-emitted
   as HTML without escaping. */

const NAMED = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
	lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
	deg: '°', times: '×', minus: '−', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è',
	aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ouml: 'ö', uuml: 'ü',
	auml: 'ä', szlig: 'ß', ccedil: 'ç', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '', zwnj: '', shy: '',
};

function decodeEntities(s) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
		if (g[0] === '#') {
			const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
			return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
		}
		const v = NAMED[g.toLowerCase()];
		return v === undefined ? m : v;
	});
}

/** Remove whole elements (with their content) by tag name; tolerates nesting. */
function dropElements(html, tags) {
	const re = new RegExp('<(/?)(' + tags.join('|') + ')\\b[^>]*>', 'gi');
	let out = '';
	let depth = 0;
	let last = 0;
	let m;
	while ((m = re.exec(html))) {
		if (!m[1]) {
			if (depth === 0) out += html.slice(last, m.index);
			depth++;
		} else if (depth > 0) {
			depth--;
			if (depth === 0) last = re.lastIndex;
		}
	}
	if (depth === 0) out += html.slice(last);
	return out;
}

function stripTags(html) {
	return decodeEntities(
		html
			.replace(/<br\s*\/?>/gi, ' ')
			.replace(/<\/(p|div|li|h[1-6]|tr|dd|dt|blockquote|section)>/gi, ' \n')
			.replace(/<[^>]+>/g, ''),
	);
}

function clean(s) {
	return s
		.replace(/\[(\d+|[a-z]|note \d+|citation needed|edit)\]/gi, '')
		.replace(/[ \t\r\f\v ]+/g, ' ')
		.replace(/ ?\n[\s\n]*/g, '\n')
		.trim();
}

function bodyOf(html) {
	const b = /<body\b[^>]*>/i.exec(html);
	let s = b ? html.slice(b.index + b[0].length) : html;
	const e = s.search(/<\/body>/i);
	if (e >= 0) s = s.slice(0, e);
	return s;
}

const NOISE = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'table', 'figure', 'nav', 'header', 'footer', 'sup'];

/**
 * Lead text of an article: its paragraphs in order, up to maxChars. Falls back
 * to all body text for pages without <p> (dictionaries, Q&A dumps…).
 */
function extractText(html, maxChars = 4000) {
	const body = dropElements(bodyOf(html), NOISE);
	let out = '';
	const pre = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
	let m;
	while ((m = pre.exec(body)) && out.length < maxChars) {
		const t = clean(stripTags(m[1]));
		if (t.length > 1) out += (out ? '\n' : '') + t;
	}
	if (out.length < 200) {
		const all = clean(stripTags(body));
		if (all.length > out.length) out = all;
	}
	return out.length > maxChars ? cutAt(out, maxChars) : out;
}

/** Shorten at a word boundary. */
function cutAt(s, n) {
	if (s.length <= n) return s;
	const cut = s.lastIndexOf(' ', n);
	return s.slice(0, cut > n * 0.6 ? cut : n).replace(/[\s,;:–—-]+$/, '') + '…';
}

/** A page's own <meta name="description">, if it has a real one. */
function extractDescription(html) {
	const head = html.slice(0, 8192);
	const m = /<meta\s+[^>]*name=["']description["'][^>]*>/i.exec(head);
	if (!m) return '';
	const c = /content=["']([^"']*)["']/i.exec(m[0]);
	const d = c ? clean(decodeEntities(c[1])) : '';
	return d.length >= 60 ? d : '';
}

function summarize(text, n = 300) {
	return cutAt(text.replace(/\n+/g, ' '), n);
}

module.exports = { extractText, extractDescription, summarize, decodeEntities, cutAt };
