'use strict';
/* End-to-end check in a real headless Edge/Chrome (CDP over WebSocket, no deps):
   opens an article in the viewer, clicks a link *inside* the archive iframe,
   and checks the viewer followed it. Also checks an external link raises the
   "leaves the offline vine" toast instead of navigating.

   node test/browser-check.js [--port 8749]   (xVine must be running) */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '8749';
const BROWSERS = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'/usr/bin/chromium',
	'/usr/bin/google-chrome',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const exe = BROWSERS.find((b) => fs.existsSync(b));
	if (!exe) throw new Error('No Chromium-family browser found');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xvine-cdp-'));
	const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=9339', '--user-data-dir=' + profile,
		'--disable-site-isolation-trials', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
	try {
		let ver;
		for (let i = 0; i < 50 && !ver; i++) {
			await sleep(200);
			ver = await fetch('http://127.0.0.1:9339/json/list').then((r) => r.json()).catch(() => null);
		}
		const page = ver.find((t) => t.type === 'page');
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((r) => ws.addEventListener('open', r));
		let id = 0;
		const pending = new Map();
		const events = [];
		ws.addEventListener('message', (ev) => {
			const m = JSON.parse(ev.data);
			if (m.id && pending.has(m.id)) {
				pending.get(m.id)(m);
				pending.delete(m.id);
			} else if (m.method) events.push(m);
		});
		const cdp = (method, params = {}) =>
			new Promise((resolve, reject) => {
				const n = ++id;
				pending.set(n, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
				ws.send(JSON.stringify({ id: n, method, params }));
			});
		const top = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

		await cdp('Page.enable');
		await cdp('Runtime.enable');
		await cdp('Page.navigate', { url: 'http://localhost:' + PORT + '/view/wikipedia_en_ray-charles_maxi/Ray_Charles' });
		await sleep(2500);

		async function inFrame(expr) {
			const tree = await cdp('Page.getFrameTree');
			const child = (tree.frameTree.childFrames || [])[0];
			if (!child) throw new Error('No archive iframe');
			const { executionContextId } = await cdp('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'check' });
			const r = await cdp('Runtime.evaluate', { expression: expr, contextId: executionContextId, returnByValue: true, awaitPromise: true });
			return { value: r.result.value, url: child.frame.url };
		}

		async function clickInFrame(selector) {
			const off = await top("(() => { const r = document.getElementById('frame').getBoundingClientRect(); return [r.left, r.top]; })()");
			const { value } = await inFrame(
				'(() => { const a = document.querySelector(' + JSON.stringify(selector) + '); a.scrollIntoView({block:"center"});' +
					' const r = a.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, a.getAttribute("href")]; })()',
			);
			const x = off[0] + value[0];
			const y = off[1] + value[1];
			for (const type of ['mousePressed', 'mouseReleased']) {
				await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
			}
			return value[2];
		}

		const results = [];
		const check = (name, ok, detail) => {
			results.push(ok);
			console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
		};

		const first = await inFrame('document.title');
		check('article loads in the archive origin', /^http:\/\/127\.0\.0\.1:/.test(first.url) && first.value === 'Ray Charles', first.url);
		const styled = await inFrame("getComputedStyle(document.querySelector('.infobox') || document.body).borderTopStyle");
		check('archive stylesheet applied', styled.value && styled.value !== 'none', 'infobox border ' + styled.value);
		const img = await inFrame("(() => { const i = document.querySelector('.infobox img'); return i ? i.naturalWidth : -1; })()");
		check('archive image decoded', img.value > 0, 'naturalWidth ' + img.value);

		const href = await clickInFrame('a[href="Georgia_on_My_Mind"]');
		await sleep(1500);
		const after = await top('({ url: location.pathname, crumb: document.getElementById("cTitle").textContent })');
		check('in-archive link followed', after.url.endsWith('/Georgia_on_My_Mind') && after.crumb === 'Georgia on My Mind', href + ' → ' + after.url);

		await clickInFrame('a[href^="https://"]');
		await sleep(600);
		const toast = await top('({ shown: !document.getElementById("toast").hidden, url: document.getElementById("toastUrl").textContent, at: location.pathname })');
		check('external link held back with a toast', toast.shown && toast.at.endsWith('/Georgia_on_My_Mind'), toast.url);

		const api = await inFrame(
			"fetch('http://localhost:" + PORT + "/api/books').then(r => r.text()).then(() => 'READ', () => 'BLOCKED')",
		);
		check('archive page cannot read the xVine API', api.value === 'BLOCKED', api.value);
		const post = await inFrame(
			"fetch('http://localhost:" + PORT + "/api/downloads/clear', { method: 'POST', headers: { 'X-xVine': '1' } })" +
				".then(r => 'SENT ' + r.status, () => 'BLOCKED')",
		);
		check('archive page cannot call xVine actions', post.value === 'BLOCKED', post.value);

		ws.close();
		console.log(results.every(Boolean) ? '\nAll checks passed.' : '\nSome checks FAILED.');
		process.exitCode = results.every(Boolean) ? 0 : 1;
	} finally {
		proc.kill();
		await sleep(300);
		try {
			fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
		} catch (e) {
			/* Edge may still hold the profile for a moment */
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
