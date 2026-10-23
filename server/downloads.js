'use strict';
/* Archive downloader: metalink mirrors, resumable (.part + Range), SHA-256
   verified against the metalink before the file joins the library. State is
   persisted so an interrupted download comes back paused after a restart. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { request, getText } = require('./net');

class Downloads extends EventEmitter {
	constructor({ dir, stateFile, questOrigin = null }) {
		super();
		this.dir = dir;
		this.questOrigin = questOrigin;
		this.stateFile = stateFile;
		this.items = new Map();
		this.active = new Map(); // id -> { req, res }
		try {
			for (const it of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) {
				if (it.state === 'downloading' || it.state === 'verifying' || it.state === 'queued') it.state = 'paused';
				this.items.set(it.id, it);
			}
		} catch (e) {
			/* first run */
		}
	}

	_save() {
		const list = [...this.items.values()].map(({ speed, ...rest }) => rest);
		fs.writeFileSync(this.stateFile, JSON.stringify(list, null, 1));
	}

	list() {
		return [...this.items.values()];
	}

	/**
	 * Start downloading a catalog entry: a Kiwix one (metalink, mirrors) or a
	 * QUEST pack (direct URL on the QUEST catalog's own host, SHA-256 given).
	 */
	add(entry) {
		const kiwix = !!(entry && entry.meta4 && /^https:\/\/[a-z0-9.-]*kiwix\.org\//.test(entry.meta4));
		let quest = false;
		if (!kiwix && entry && entry.url && this.questOrigin) {
			try {
				quest = new URL(entry.url).origin === this.questOrigin && /^[0-9a-f]{64}$/.test(entry.sha256 || '');
			} catch (e) {
				quest = false;
			}
		}
		if (!kiwix && !quest) throw new Error('Only archives from the Kiwix or QUEST catalogs can be downloaded');
		const file = path.basename(entry.file || '');
		if (!/^[\w.@+-]+\.zim$/.test(file)) throw new Error('Unexpected archive file name');
		for (const it of this.items.values()) {
			if (it.file === file && it.state !== 'error' && it.state !== 'cancelled') return it;
		}
		const it = {
			id: crypto.randomBytes(6).toString('hex'),
			catalogId: entry.id,
			name: entry.name,
			flavour: entry.flavour,
			title: entry.title,
			file,
			source: quest ? 'quest' : 'kiwix',
			meta4: kiwix ? entry.meta4 : null,
			// QUEST packs: one URL and a published checksum, no metalink step.
			mirrors: quest ? [entry.url] : undefined,
			sha256: quest ? entry.sha256 : undefined,
			size: entry.size || 0,
			received: 0,
			state: 'queued',
			error: null,
			startedAt: Date.now(),
		};
		this.items.set(it.id, it);
		this._save();
		this._run(it);
		return it;
	}

	pause(id) {
		const it = this.items.get(id);
		if (!it) return;
		this._abort(id);
		if (it.state === 'downloading' || it.state === 'queued') it.state = 'paused';
		this._save();
		this.emit('change', it);
	}

	resume(id) {
		const it = this.items.get(id);
		if (!it || !(it.state === 'paused' || it.state === 'error')) return;
		it.error = null;
		this._run(it);
	}

	cancel(id) {
		const it = this.items.get(id);
		if (!it) return;
		this._abort(id);
		fs.rm(this._partPath(it), { force: true }, () => {});
		this.items.delete(id);
		this._save();
		this.emit('change', it);
	}

	/** Forget finished/cancelled rows. */
	clearFinished() {
		for (const [id, it] of this.items) if (it.state === 'done') this.items.delete(id);
		this._save();
	}

	_abort(id) {
		const a = this.active.get(id);
		if (a) {
			a.aborted = true;
			if (a.res) a.res.destroy();
			this.active.delete(id);
		}
	}

	_partPath(it) {
		return path.join(this.dir, it.file + '.part');
	}

	async _run(it) {
		const ctl = { aborted: false };
		this.active.set(it.id, ctl);
		it.state = 'downloading';
		it.speed = 0;
		this.emit('change', it);
		try {
			if (!it.mirrors) {
				const m4 = await getText(it.meta4, { timeout: 20000 });
				const urls = [...m4.matchAll(/<url[^>]*priority="(\d+)"[^>]*>([^<]+)<\/url>/g)]
					.sort((a, b) => a[1] - b[1])
					.map((m) => m[2].trim())
					.filter((u) => /^https?:\/\//.test(u));
				const sha = /<hash type="sha-256">([0-9a-f]{64})<\/hash>/.exec(m4);
				const size = /<size>(\d+)<\/size>/.exec(m4);
				it.mirrors = urls.slice(0, 6);
				it.mirrors.push(it.meta4.replace(/\.meta4$/, ''));
				it.sha256 = sha ? sha[1] : null;
				if (size) it.size = parseInt(size[1], 10);
				this._save();
			}
			if (ctl.aborted) return;

			const part = this._partPath(it);
			let lastErr = null;
			for (const url of it.mirrors) {
				if (ctl.aborted) return;
				try {
					await this._fetchInto(it, url, part, ctl);
					lastErr = null;
					break;
				} catch (err) {
					if (ctl.aborted) return;
					lastErr = err;
				}
			}
			if (lastErr) throw lastErr;
			if (ctl.aborted) return;

			it.state = 'verifying';
			this.emit('change', it);
			if (it.sha256) {
				const got = await sha256File(part);
				if (got !== it.sha256) {
					fs.rmSync(part, { force: true });
					it.received = 0;
					throw new Error('Checksum mismatch — the download was corrupted and has been discarded');
				}
			}
			const final = path.join(this.dir, it.file);
			fs.renameSync(part, final);
			it.state = 'done';
			it.finishedAt = Date.now();
			it.path = final;
			this.active.delete(it.id);
			this._save();
			this.emit('change', it);
			this.emit('complete', it);
		} catch (err) {
			this.active.delete(it.id);
			if (ctl.aborted) return;
			it.state = 'error';
			it.error = err.message;
			this._save();
			this.emit('change', it);
		}
	}

	async _fetchInto(it, url, part, ctl) {
		let have = 0;
		try {
			have = fs.statSync(part).size;
		} catch (e) {
			/* fresh */
		}
		if (it.size && have >= it.size) return;
		const res = await request(url, { headers: have ? { Range: 'bytes=' + have + '-' } : {}, timeout: 30000 });
		ctl.res = res;
		if (ctl.aborted) {
			res.destroy();
			return;
		}
		if (res.statusCode === 200 && have) have = 0; // server ignored Range: start over
		else if (res.statusCode !== 200 && res.statusCode !== 206) {
			res.resume();
			throw new Error('HTTP ' + res.statusCode + ' from ' + new URL(url).host);
		}
		const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
		it.received = have;
		let windowStart = Date.now();
		let windowBytes = 0;
		await new Promise((resolve, reject) => {
			res.on('data', (chunk) => {
				it.received += chunk.length;
				windowBytes += chunk.length;
				const now = Date.now();
				if (now - windowStart >= 1000) {
					it.speed = Math.round((windowBytes * 1000) / (now - windowStart));
					windowStart = now;
					windowBytes = 0;
					this.emit('change', it);
				}
			});
			res.on('error', reject);
			// A destroyed response (pause/cancel, dropped link) never ends the
			// pipe; close the file ourselves so the size check below runs.
			res.on('close', () => {
				if (!res.complete) out.end();
			});
			out.on('error', reject);
			out.on('finish', resolve);
			res.pipe(out);
		});
		this._save();
		if (it.size && it.received < it.size) throw new Error('Connection closed early');
	}
}

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const h = crypto.createHash('sha256');
		fs.createReadStream(file)
			.on('data', (d) => h.update(d))
			.on('error', reject)
			.on('end', () => resolve(h.digest('hex')));
	});
}

module.exports = { Downloads };
