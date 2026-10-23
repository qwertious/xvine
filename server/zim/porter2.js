'use strict';
/* Snowball English ("Porter2") stemmer — the stemmer Xapian uses for
   language "en", so query terms match what Kiwix's indexer stored. Follows
   https://snowballstem.org/algorithms/english/stemmer.html */

const EXC1 = {
	skis: 'ski', skies: 'sky', dying: 'die', lying: 'lie', tying: 'tie', idly: 'idl', gently: 'gentl', ugly: 'ugli',
	early: 'earli', only: 'onli', singly: 'singl', sky: 'sky', news: 'news', howe: 'howe', atlas: 'atlas',
	cosmos: 'cosmos', bias: 'bias', andes: 'andes',
};
const EXC2 = new Set(['inning', 'outing', 'canning', 'herring', 'earring', 'proceed', 'exceed', 'succeed']);

const isV = (c) => c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u' || c === 'y';

function regions(w) {
	let r1 = w.length;
	const m = /^(gener|commun|arsen)/.exec(w);
	if (m) r1 = m[1].length;
	else {
		for (let i = 1; i < w.length; i++) {
			if (!isV(w[i]) && isV(w[i - 1])) {
				r1 = i + 1;
				break;
			}
		}
	}
	let r2 = w.length;
	for (let i = r1 + 1; i < w.length; i++) {
		if (!isV(w[i]) && isV(w[i - 1])) {
			r2 = i + 1;
			break;
		}
	}
	return [r1, r2];
}

/** Does w end (at index `end`) in a short syllable? */
function shortSyllableAt(w, end) {
	const n = end;
	if (n === 2) return isV(w[0]) && !isV(w[1]);
	if (n < 3) return false;
	const a = w[n - 3];
	const b = w[n - 2];
	const c = w[n - 1];
	return !isV(a) && isV(b) && !isV(c) && c !== 'w' && c !== 'x' && c !== 'Y';
}

function hasVowel(s) {
	for (let i = 0; i < s.length; i++) if (isV(s[i])) return true;
	return false;
}

/** The longest of `list` that w ends with, or null. */
function longest(w, list) {
	let best = null;
	for (const s of list) if (w.endsWith(s) && (!best || s.length > best.length)) best = s;
	return best;
}

const STEP2 = {
	tional: 'tion', enci: 'ence', anci: 'ance', abli: 'able', entli: 'ent', izer: 'ize', ization: 'ize',
	ational: 'ate', ation: 'ate', ator: 'ate', alism: 'al', aliti: 'al', alli: 'al', fulness: 'ful', ousli: 'ous',
	ousness: 'ous', iveness: 'ive', iviti: 'ive', biliti: 'ble', bli: 'ble', ogi: 'og', fulli: 'ful', lessli: 'less',
	li: '',
};
const STEP3 = { tional: 'tion', ational: 'ate', alize: 'al', icate: 'ic', iciti: 'ic', ical: 'ic', ful: '', ness: '', ative: '' };
const STEP4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'ion'];

function stem(word) {
	let w = word;
	if (w.length <= 2) return w;
	if (EXC1[w]) return EXC1[w];
	if (w[0] === "'") w = w.slice(1);
	if (w[0] === 'y') w = 'Y' + w.slice(1);
	w = w.replace(/([aeiouy])y/g, '$1Y');
	const [r1, r2] = regions(w);

	// Step 0
	const s0 = longest(w, ["'s'", "'s", "'"]);
	if (s0) w = w.slice(0, -s0.length);

	// Step 1a
	const s1a = longest(w, ['sses', 'ied', 'ies', 's', 'us', 'ss']);
	if (s1a === 'sses') w = w.slice(0, -2);
	else if (s1a === 'ied' || s1a === 'ies') w = w.length > 4 ? w.slice(0, -2) : w.slice(0, -1);
	else if (s1a === 's') {
		if (hasVowel(w.slice(0, -2))) w = w.slice(0, -1);
	}
	if (EXC2.has(w)) return w;

	// Step 1b
	const s1b = longest(w, ['eed', 'eedly', 'ed', 'edly', 'ing', 'ingly']);
	if (s1b === 'eed' || s1b === 'eedly') {
		if (w.length - s1b.length >= r1) w = w.slice(0, -s1b.length) + 'ee';
	} else if (s1b) {
		const pre = w.slice(0, -s1b.length);
		if (hasVowel(pre)) {
			w = pre;
			if (/(at|bl|iz)$/.test(w)) w += 'e';
			else if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/.test(w)) w = w.slice(0, -1);
			else if (r1 >= w.length && shortSyllableAt(w, w.length)) w += 'e';
		}
	}

	// Step 1c
	if (w.length > 2 && (w.endsWith('y') || w.endsWith('Y')) && !isV(w[w.length - 2])) w = w.slice(0, -1) + 'i';

	// Step 2
	const s2 = longest(w, Object.keys(STEP2));
	if (s2 && w.length - s2.length >= r1) {
		if (s2 === 'ogi') {
			if (w[w.length - 4] === 'l') w = w.slice(0, -3) + 'og';
		} else if (s2 === 'li') {
			if (/[cdeghkmnrt]li$/.test(w)) w = w.slice(0, -2);
		} else w = w.slice(0, -s2.length) + STEP2[s2];
	}

	// Step 3
	const s3 = longest(w, Object.keys(STEP3));
	if (s3 && w.length - s3.length >= r1) {
		if (s3 === 'ative') {
			if (w.length - 5 >= r2) w = w.slice(0, -5);
		} else w = w.slice(0, -s3.length) + STEP3[s3];
	}

	// Step 4
	const s4 = longest(w, STEP4);
	if (s4 && w.length - s4.length >= r2) {
		if (s4 === 'ion') {
			if (/[st]ion$/.test(w)) w = w.slice(0, -3);
		} else w = w.slice(0, -s4.length);
	}

	// Step 5
	if (w.endsWith('e')) {
		const at = w.length - 1;
		if (at >= r2 || (at >= r1 && !shortSyllableAt(w, at))) w = w.slice(0, -1);
	} else if (w.endsWith('ll') && w.length - 1 >= r2) {
		w = w.slice(0, -1);
	}

	return w.replace(/Y/g, 'y');
}

module.exports = { stem };
