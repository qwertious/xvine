'use strict';
/* Minimal HTTP(S) client: redirects, timeouts, no dependencies. */

const http = require('http');
const https = require('https');

const UA = 'xVine/0.1 (XIO offline library; +https://qwertious.org/xio/)';

/** Resolve to the final IncomingMessage after following redirects. */
function request(url, { headers = {}, timeout = 20000, maxRedirects = 8, method = 'GET' } = {}) {
	return new Promise((resolve, reject) => {
		const go = (u, left) => {
			let mod;
			try {
				mod = new URL(u).protocol === 'http:' ? http : https;
			} catch (e) {
				return reject(new Error('Bad URL: ' + u));
			}
			const req = mod.request(u, { method, headers: { 'User-Agent': UA, ...headers }, timeout }, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					if (left <= 0) return reject(new Error('Too many redirects'));
					return go(new URL(res.headers.location, u).toString(), left - 1);
				}
				res.finalUrl = u;
				resolve(res);
			});
			req.on('timeout', () => req.destroy(new Error('Timed out contacting ' + new URL(u).host)));
			req.on('error', reject);
			req.end();
		};
		go(url, maxRedirects);
	});
}

async function getText(url, opts) {
	const res = await request(url, opts);
	const chunks = [];
	for await (const c of res) chunks.push(c);
	const body = Buffer.concat(chunks).toString('utf8');
	if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode + ' from ' + new URL(url).host);
	return body;
}

module.exports = { request, getText, UA };
