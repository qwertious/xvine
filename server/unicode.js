'use strict';
/* Unicode helpers that also work without ICU. nodejs-mobile (the Android
   build) has no Intl support, so regex property escapes (\p{L}) are a syntax
   error there and String.prototype.normalize may do nothing. Desktop Node uses
   the real thing; elsewhere these fall back to explicit ranges and a Latin
   accent table, which covers what search needs. */

let hasProps = true;
try {
	new RegExp('\\p{L}', 'u');
} catch (e) {
	hasProps = false;
}

// Letters: Latin, Greek, Cyrillic, Armenian, Hebrew, Arabic, Indic, Thai,
// Georgian, Hangul Jamo, Latin Extended Additional, Greek Extended, Kana,
// CJK, Hangul syllables, CJK compatibility.
const LETTER_RANGES =
	'A-Za-z\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02AF\\u0370-\\u0373\\u0376-\\u03FF' +
	'\\u0400-\\u0481\\u048A-\\u052F\\u0531-\\u0556\\u0561-\\u0587\\u05D0-\\u05EA\\u0620-\\u064A\\u066E-\\u06D3' +
	'\\u0900-\\u0963\\u0971-\\u097F\\u0980-\\u09E5\\u0A00-\\u0DFF\\u0E01-\\u0E4E\\u10A0-\\u10FF\\u1100-\\u11FF' +
	'\\u1E00-\\u1FFF\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF';
const DIGIT_RANGES = '0-9\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F';

const LETTER = hasProps ? '\\p{L}' : LETTER_RANGES;
const ALNUM = hasProps ? '\\p{L}\\p{N}' : LETTER_RANGES + DIGIT_RANGES;

const normalizeWorks = (() => {
	try {
		return 'é'.normalize('NFD').length === 2;
	} catch (e) {
		return false;
	}
})();

// Fallback decompositions for Latin-1 Supplement and Latin Extended-A.
const ACCENTS = {
	a: 'àáâãäåāăą',
	c: 'çćĉċč',
	d: 'ď',
	e: 'èéêëēĕėęě',
	g: 'ĝğġģ',
	h: 'ĥ',
	i: 'ìíîïĩīĭį',
	j: 'ĵ',
	k: 'ķ',
	l: 'ĺļľ',
	n: 'ñńņň',
	o: 'òóôõöōŏő',
	r: 'ŕŗř',
	s: 'śŝşš',
	t: 'ţť',
	u: 'ùúûüũūŭůűų',
	w: 'ŵ',
	y: 'ýÿŷ',
	z: 'źżž',
};
const ACCENT_MAP = new Map();
for (const [base, chars] of Object.entries(ACCENTS)) {
	for (const ch of chars) {
		ACCENT_MAP.set(ch, base);
		ACCENT_MAP.set(ch.toUpperCase(), base.toUpperCase());
	}
}

function unaccent(s) {
	if (normalizeWorks) return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
	return s.replace(/[À-ſ]/g, (c) => ACCENT_MAP.get(c) || c).replace(/[̀-ͯ]/g, '');
}

module.exports = { LETTER, ALNUM, unaccent, hasProps, normalizeWorks };
