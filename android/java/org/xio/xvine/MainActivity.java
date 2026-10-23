package org.xio.xvine;

import android.app.Activity;
import android.app.NotificationManager;
import android.app.Notification;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * xVine's window: a WebView on the local server. Archive pages stay inside;
 * anything off-device opens in the system browser, and only on a tap.
 */
public class MainActivity extends Activity {
	private static final String UI = "http://localhost:" + NodeService.PORT + "/";
	private static final int PICK_ZIM = 1;

	private WebView web;
	private final Handler ui = new Handler(Looper.getMainLooper());
	private ValueCallback<Uri[]> pendingChooser;

	@Override
	protected void onCreate(Bundle state) {
		super.onCreate(state);
		getWindow().setStatusBarColor(Color.BLACK);
		getWindow().setNavigationBarColor(Color.BLACK);

		web = new WebView(this);
		web.setBackgroundColor(Color.BLACK);
		setContentView(web);

		WebSettings s = web.getSettings();
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setSupportMultipleWindows(true);
		s.setJavaScriptCanOpenWindowsAutomatically(false);
		s.setAllowFileAccess(false);
		s.setAllowContentAccess(false);
		s.setMediaPlaybackRequiresUserGesture(false);
		s.setUserAgentString(s.getUserAgentString() + " xVineAndroid/0.1");

		web.setWebViewClient(new WebViewClient() {
			@Override
			public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
				return leavesDevice(req.getUrl()) && openExternally(req.getUrl());
			}
		});
		web.setWebChromeClient(new WebChromeClient() {
			// "Open online" links use target=_blank. Honour them only on a
			// real tap, and send them to the system browser.
			@Override
			public boolean onCreateWindow(WebView v, boolean dialog, boolean userGesture, Message resultMsg) {
				if (!userGesture) return false;
				WebView probe = new WebView(MainActivity.this);
				probe.setWebViewClient(new WebViewClient() {
					@Override
					public boolean shouldOverrideUrlLoading(WebView p, WebResourceRequest req) {
						if (leavesDevice(req.getUrl())) openExternally(req.getUrl());
						p.destroy();
						return true;
					}
				});
				((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
				resultMsg.sendToTarget();
				return true;
			}

			// The library's "Import .zim" button: pick a file, copy it into
			// the library folder, then register it with the server.
			@Override
			public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
				if (pendingChooser != null) pendingChooser.onReceiveValue(null);
				pendingChooser = cb;
				Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
				startActivityForResult(i, PICK_ZIM);
				return true;
			}
		});

		web.loadDataWithBaseURL(null,
				"<body style='background:#000;color:#8a8a8a;font:14px monospace;display:grid;place-items:center;height:90vh'>"
						+ "<div style='text-align:center'><div style='color:#f2f2f2;letter-spacing:.3em;font-size:28px'>XVINE</div>"
						+ "<p>&gt; starting your offline library…</p></div>",
				"text/html", "utf-8", null);

		NodeService.ensureRunning(this);
		waitForServer(0);
	}

	private static boolean leavesDevice(Uri u) {
		String h = u.getHost();
		return h != null && !h.equals("localhost") && !h.equals("127.0.0.1");
	}

	private boolean openExternally(Uri u) {
		String scheme = u.getScheme();
		if (!"http".equals(scheme) && !"https".equals(scheme)) return true;
		try {
			startActivity(new Intent(Intent.ACTION_VIEW, u));
		} catch (Exception e) {
			Log.w(NodeService.TAG, "no browser for " + u);
		}
		return true;
	}

	/** Poll the server until it answers, then show it. */
	private void waitForServer(final int attempt) {
		new Thread(() -> {
			boolean up = false;
			try {
				HttpURLConnection c = (HttpURLConnection) new URL(UI + "api/status").openConnection();
				c.setConnectTimeout(1000);
				c.setReadTimeout(1000);
				up = c.getResponseCode() == 200;
				c.disconnect();
			} catch (Exception e) {
				up = false;
			}
			final boolean ready = up;
			ui.post(() -> {
				if (ready) web.loadUrl(UI);
				else if (attempt < 120) ui.postDelayed(() -> waitForServer(attempt + 1), 250);
				else web.loadData("<body style='background:#000;color:#ff5c5c;font:14px monospace;padding:2em'>"
						+ "xVine's server did not start. Close the app fully and reopen it.", "text/html", "utf-8");
			});
		}).start();
	}

	@Override
	protected void onActivityResult(int req, int result, Intent data) {
		super.onActivityResult(req, result, data);
		if (req != PICK_ZIM) return;
		if (pendingChooser != null) {
			pendingChooser.onReceiveValue(null); // we handle the file ourselves
			pendingChooser = null;
		}
		if (result == RESULT_OK && data != null && data.getData() != null) importArchive(data.getData());
	}

	/** Copy a picked .zim into the library and add it (progress in a notification). */
	private void importArchive(final Uri uri) {
		final String name = displayName(uri);
		if (name == null || !name.toLowerCase().endsWith(".zim")) {
			web.evaluateJavascript("alert('Please choose a .zim archive.')", null);
			return;
		}
		new Thread(() -> {
			final NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
			File lib = new File(NodeService.dataDir(this), "library");
			lib.mkdirs();
			File part = new File(lib, name + ".part");
			File dest = new File(lib, name);
			long total = size(uri);
			try (InputStream in = getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(part)) {
				byte[] buf = new byte[1 << 20];
				long done = 0, lastNote = 0;
				int n;
				while ((n = in.read(buf)) > 0) {
					out.write(buf, 0, n);
					done += n;
					long now = System.currentTimeMillis();
					if (now - lastNote > 1000) {
						lastNote = now;
						nm.notify(2, progress("Importing " + name, total, done));
					}
				}
			} catch (Exception e) {
				part.delete();
				nm.cancel(2);
				Log.e(NodeService.TAG, "import failed", e);
				ui.post(() -> web.evaluateJavascript("alert('Import failed: " + jsEscape(e.getMessage()) + "')", null));
				return;
			}
			part.renameTo(dest);
			nm.cancel(2);
			boolean ok = postAdd(dest.getAbsolutePath());
			ui.post(() -> web.evaluateJavascript(ok
					? "location.pathname === '/library' ? location.reload() : alert('Added " + jsEscape(name) + " to your library.')"
					: "alert('Copied, but xVine could not open " + jsEscape(name) + ".')", null));
		}).start();
	}

	private Notification progress(String title, long total, long done) {
		Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "xvine") : new Notification.Builder(this);
		b.setContentTitle(title).setSmallIcon(android.R.drawable.stat_sys_download).setOnlyAlertOnce(true).setOngoing(true);
		if (total > 0) b.setProgress(1000, (int) (done * 1000 / total), false);
		else b.setProgress(0, 0, true);
		return b.build();
	}

	/** POST /api/books/add with the UI's origin, as the page itself would. */
	private boolean postAdd(String path) {
		try {
			HttpURLConnection c = (HttpURLConnection) new URL(UI + "api/books/add").openConnection();
			c.setRequestMethod("POST");
			c.setDoOutput(true);
			c.setRequestProperty("Content-Type", "application/json");
			c.setRequestProperty("Origin", "http://localhost:" + NodeService.PORT);
			c.setRequestProperty("X-xVine", "1");
			String body = "{\"path\":\"" + path.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
			try (OutputStream os = c.getOutputStream()) {
				os.write(body.getBytes("UTF-8"));
			}
			int code = c.getResponseCode();
			c.disconnect();
			return code == 200;
		} catch (Exception e) {
			Log.e(NodeService.TAG, "add failed", e);
			return false;
		}
	}

	private String displayName(Uri uri) {
		try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
			if (c != null && c.moveToFirst()) return new File(c.getString(0)).getName().replaceAll("[^\\w.@+-]", "_");
		} catch (Exception e) {
			// fall through
		}
		return null;
	}

	private long size(Uri uri) {
		try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.SIZE}, null, null, null)) {
			if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
		} catch (Exception e) {
			// unknown
		}
		return -1;
	}

	private static String jsEscape(String s) {
		return s == null ? "" : s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ");
	}

	@Override
	public boolean onKeyDown(int keyCode, KeyEvent event) {
		if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
			web.goBack();
			return true;
		}
		return super.onKeyDown(keyCode, event);
	}
}
