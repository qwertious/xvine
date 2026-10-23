'use strict';
/* Background indexer: walks one ZIM's articles in cluster order (so each
   cluster is decompressed once) and feeds their lead text into the FTS index.
   Runs in a worker thread; resumable, because the article order is a pure
   function of the file. */

const { parentPort, workerData, isMainThread } = require('worker_threads');
const { ZimArchive } = require('./zim/reader');
const { Store } = require('./store');
const { extractText, summarize } = require('./text');

const BATCH = 500;

async function run({ file, sourceId, dbPath, leadChars }) {
	const store = new Store(dbPath);
	const zim = await ZimArchive.open(file, { clusterCacheBytes: 16 * 1024 * 1024, direntCacheEntries: 4096 });
	const post = (m) => parentPort && parentPort.postMessage(m);

	// 1. Collect the article set (front articles, no redirects, HTML only).
	post({ type: 'progress', phase: 'scanning', done: 0, total: zim.titleListing ? zim.titleListing.count : 0 });
	const n = zim.titleListing ? zim.titleListing.count : 0;
	const idx = new Uint32Array(n);
	const clu = new Uint32Array(n);
	const blo = new Uint32Array(n);
	let k = 0;
	let seen = 0;
	for await (const i of zim.titleOrderedIndices()) {
		const e = await zim.entryAt(i);
		if (++seen % 20000 === 0) post({ type: 'progress', phase: 'scanning', done: seen, total: n });
		if (e.isRedirect || e.namespace !== zim.contentNs || !/html/.test(e.mimeType || '')) continue;
		idx[k] = i;
		clu[k] = e.cluster;
		blo[k] = e.blob;
		k++;
	}
	const order = Array.from({ length: k }, (_, j) => j).sort((a, b) => clu[a] - clu[b] || blo[a] - blo[b]);

	// 2. Resume where a previous run stopped.
	const src = store.source(sourceId);
	let done = src && src.uuid === zim.uuid && src.state === 'indexing' ? Math.min(src.done, k) : 0;
	if (done === 0) store.clearDocs(sourceId);
	store.setSource(sourceId, { uuid: zim.uuid, state: 'indexing', total: k, done, error: null });

	// 3. Index.
	let lastPost = 0;
	while (done < k) {
		const end = Math.min(k, done + BATCH);
		const rows = [];
		for (let j = done; j < end; j++) {
			const o = order[j];
			const e = await zim.entryAt(idx[o]);
			let text = '';
			try {
				const html = (await zim.readBlob(clu[o], blo[o])).toString('utf8');
				text = extractText(html, leadChars);
			} catch (err) {
				text = '';
			}
			rows.push([zim.urlPathOf(e), e.title, summarize(text, 320), text]);
		}
		store.tx(() => {
			for (const r of rows) store.addDoc(sourceId, r[0], r[1], r[2], r[3]);
			store.setSource(sourceId, { done: end });
		});
		done = end;
		const now = Date.now();
		if (now - lastPost > 400 || done === k) {
			post({ type: 'progress', phase: 'indexing', done, total: k });
			lastPost = now;
		}
	}

	store.setSource(sourceId, { state: 'done', done: k, total: k });
	await zim.close();
	post({ type: 'done', total: k });
}

if (!isMainThread && workerData && workerData.task === 'index') {
	run(workerData).catch((err) => {
		parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
	});
}

module.exports = { run };
