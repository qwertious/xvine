'use strict';
/* Cluster decompression. Desktop Node (>= 22.15) has zstd built in; Node 18
   (nodejs-mobile on Android) does not, so fall back to the pure-JS decoder. */

const zlib = require('zlib');

let fzstd = null;

function zstd(buf) {
	if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
	if (!fzstd) {
		fzstd = require('../vendor/fzstd');
	}
	return Buffer.from(fzstd.decompress(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
}

function xz() {
	/* Only ZIMs made before ~2021 use xz; everything in the current Kiwix
	   catalog is zstd. */
	throw new Error('This archive uses xz compression (pre-2021 ZIM), which xVine does not read yet');
}

const COMPRESSION = { NONE0: 0, NONE: 1, ZLIB: 2, BZIP2: 3, XZ: 4, ZSTD: 5 };

function decompress(kind, buf) {
	switch (kind) {
		case COMPRESSION.NONE0:
		case COMPRESSION.NONE:
			return buf;
		case COMPRESSION.XZ:
			return xz(buf);
		case COMPRESSION.ZSTD:
			return zstd(buf);
		default:
			throw new Error('Unsupported ZIM cluster compression ' + kind);
	}
}

module.exports = { decompress, COMPRESSION };
