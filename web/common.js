/* xVine shared UI: topbar, search box with suggestions, small helpers. */
(function () {
	'use strict';

	var MARK =
		'<svg class="mark" viewBox="0 0 100 100" aria-hidden="true">' +
		'<path d="M50 90V52M50 52C50 36 32 34 26 18M50 52C50 38 66 36 74 22M50 70C60 66 70 66 80 58"/>' +
		'<circle class="node" cx="26" cy="18" r="8"/><circle class="node" cx="74" cy="22" r="8"/>' +
		'<circle class="node" cx="80" cy="58" r="7"/><circle class="node" cx="50" cy="52" r="6"/></svg>';

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function encodePath(p) {
		return String(p).split('/').map(encodeURIComponent).join('/');
	}

	function viewUrl(source, path) {
		return '/view/' + encodeURIComponent(source) + '/' + encodePath(path);
	}

	function fmtBytes(n) {
		if (!n) return '0 B';
		var u = ['B', 'KB', 'MB', 'GB', 'TB'];
		var i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
		var v = n / Math.pow(1024, i);
		return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
	}

	function fmtNum(n) {
		return n == null ? '—' : Number(n).toLocaleString();
	}

	function api(path) {
		return fetch('/api/' + path).then(function (r) {
			return r.json().then(function (j) {
				if (!r.ok) {
					var e = new Error(j.error || 'HTTP ' + r.status);
					e.data = j;
					throw e;
				}
				return j;
			});
		});
	}

	function post(path, body) {
		return fetch('/api/' + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-xVine': '1' },
			body: JSON.stringify(body || {}),
		}).then(function (r) {
			return r.json().then(function (j) {
				if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
				return j;
			});
		});
	}

	// Archive pages live on a separate origin from the UI (see server/main.js).
	var CONTENT_ORIGIN = location.protocol + '//127.0.0.1:' + location.port;

	function icon(source) {
		return '/icon/' + encodeURIComponent(source);
	}

	/* ------------------------------------------------------------ search box */

	function searchBoxHtml(big, value) {
		return (
			'<div class="searchbox' + (big ? ' big' : '') + '">' +
			'<form role="search" action="/search" autocomplete="off">' +
			'<span class="prompt" aria-hidden="true">&gt;</span>' +
			'<input name="q" type="search" spellcheck="false" placeholder="Search the vine" aria-label="Search xVine" value="' +
			esc(value || '') + '"' + (big ? ' autofocus' : '') + '>' +
			'<button type="submit">Search</button></form>' +
			'<ul class="suggest" role="listbox" hidden></ul></div>'
		);
	}

	function mountSearch(root) {
		var form = root.querySelector('form');
		var input = root.querySelector('input');
		var list = root.querySelector('.suggest');
		var items = [];
		var active = -1;
		var seq = 0;
		var timer = null;

		function close() {
			list.hidden = true;
			active = -1;
		}

		function render() {
			if (!items.length) return close();
			list.innerHTML = items
				.map(function (s, i) {
					return (
						'<li role="option"' + (i === active ? ' class="active"' : '') + '><a href="' + viewUrl(s.source, s.path) + '">' +
						'<span class="t">' + esc(s.title) + (s.target ? ' <span class="r">→ ' + esc(s.target) + '</span>' : '') + '</span>' +
						'<span class="s">' + esc(s.sourceTitle) + '</span></a></li>'
					);
				})
				.join('');
			list.hidden = false;
		}

		input.addEventListener('input', function () {
			clearTimeout(timer);
			var q = input.value.trim();
			if (!q) {
				items = [];
				return close();
			}
			timer = setTimeout(function () {
				var my = ++seq;
				api('suggest?q=' + encodeURIComponent(q))
					.then(function (j) {
						if (my !== seq) return;
						items = j.suggestions;
						active = -1;
						render();
					})
					.catch(close);
			}, 90);
		});

		input.addEventListener('keydown', function (e) {
			if (list.hidden) return;
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				var n = items.length;
				active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
				render();
			} else if (e.key === 'Enter' && active >= 0) {
				e.preventDefault();
				location.href = viewUrl(items[active].source, items[active].path);
			} else if (e.key === 'Escape') {
				close();
			}
		});

		form.addEventListener('submit', function (e) {
			if (!input.value.trim()) e.preventDefault();
		});

		document.addEventListener('click', function (e) {
			if (!root.contains(e.target)) close();
		});
		input.addEventListener('focus', function () {
			if (items.length) render();
		});
		return { input: input };
	}

	/* ---------------------------------------------------------------- topbar */

	function topbar(opts) {
		opts = opts || {};
		var el = document.getElementById('topbar');
		if (!el) return null;
		var here = location.pathname;
		el.className = 'topbar' + (opts.extraClass ? ' ' + opts.extraClass : '');
		el.innerHTML =
			'<a class="brand" href="/" aria-label="xVine home">' + MARK + '<span>XVINE</span></a>' +
			(opts.search === false ? '' : searchBoxHtml(false, opts.query)) +
			'<nav class="topnav">' +
			'<a href="/"' + (here === '/' ? ' aria-current="page"' : '') + '>Home</a>' +
			'<a href="/library"' + (here === '/library' ? ' aria-current="page"' : '') + '>Library</a>' +
			'</nav>';
		var sb = el.querySelector('.searchbox');
		return sb ? mountSearch(sb) : null;
	}

	window.xv = {
		MARK: MARK,
		CONTENT_ORIGIN: CONTENT_ORIGIN,
		esc: esc,
		encodePath: encodePath,
		viewUrl: viewUrl,
		fmtBytes: fmtBytes,
		fmtNum: fmtNum,
		api: api,
		post: post,
		icon: icon,
		searchBoxHtml: searchBoxHtml,
		mountSearch: mountSearch,
		topbar: topbar,
	};
})();
