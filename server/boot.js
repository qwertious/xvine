'use strict';
/* Entry point for embedded runs (the Android app): loads main.js, and if that
   throws while loading, writes the error to the --log file synchronously,
   because there is no terminal and the process may die before stderr drains. */

const i = process.argv.indexOf('--log');
const logFile = i > 0 ? process.argv[i + 1] : null;

function record(what, err) {
	if (!logFile) return;
	try {
		require('fs').appendFileSync(logFile, new Date().toISOString() + ' BOOT ' + what + ' ' + (err && err.stack ? err.stack : String(err)) + '\n');
	} catch (e) {
		/* nothing more we can do */
	}
}

record('start', 'node ' + process.version + ' ' + process.platform + '/' + process.arch);
try {
	require('./main.js');
} catch (err) {
	record('failed', err);
	throw err;
}
