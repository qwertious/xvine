/* Injected into every archive page. Archives are served from their own origin
   (127.0.0.1), cross-origin to the xVine UI (localhost), so all a page can do
   is talk to the viewer by postMessage. */
(function () {
	'use strict';
	var UI = location.protocol + '//localhost:' + location.port;
	if (window.top === window) {
		// Opened directly: put it back inside the viewer.
		var m = /^\/content\/(.*)$/.exec(location.pathname);
		if (m) location.replace(UI + '/view/' + m[1] + location.search + location.hash);
		return;
	}
	function send(msg) {
		parent.postMessage(msg, UI);
	}
	function report() {
		send({ type: 'xvine:nav', path: location.pathname, hash: location.hash, title: document.title });
	}
	report();
	window.addEventListener('hashchange', report);
	document.addEventListener('DOMContentLoaded', report);

	document.addEventListener(
		'click',
		function (e) {
			if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
			var a = e.target.closest && e.target.closest('a[href]');
			if (!a) return;
			var url;
			try {
				url = new URL(a.getAttribute('href'), location.href);
			} catch (err) {
				return;
			}
			if (url.origin === UI) {
				e.preventDefault();
				send({ type: 'xvine:go', url: url.pathname + url.search + url.hash });
				return;
			}
			if (url.origin !== location.origin) {
				if (/^https?:$/.test(url.protocol)) {
					e.preventDefault();
					send({ type: 'xvine:external', url: url.href });
				}
				return;
			}
			// xVine's own pages (search, library…) live outside /content/:
			// ask the viewer to navigate (the frame may not move the top window).
			if (!/^\/content\//.test(url.pathname)) {
				e.preventDefault();
				send({ type: 'xvine:go', url: url.pathname + url.search + url.hash });
			}
		},
		true,
	);
})();
