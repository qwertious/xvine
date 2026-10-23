package org.xio.xvine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;

/**
 * Foreground service hosting xVine's Node server. The server code ships in
 * the APK's assets and is unpacked to app storage on first run of each
 * version; archives and state live in app-specific external storage.
 */
public class NodeService extends Service {
	static final String TAG = "xvine";
	static final int PORT = 8749;
	private static final String CHANNEL = "xvine";
	private static volatile boolean started = false;

	static void ensureRunning(Context ctx) {
		Intent i = new Intent(ctx, NodeService.class);
		if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
		else ctx.startService(i);
	}

	/** Where archives, the library state and logs live. */
	static File dataDir(Context ctx) {
		File ext = ctx.getExternalFilesDir(null);
		File d = new File(ext != null ? ext : ctx.getFilesDir(), "xvine");
		d.mkdirs();
		return d;
	}

	@Override
	public void onCreate() {
		super.onCreate();
		NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
		if (Build.VERSION.SDK_INT >= 26) {
			NotificationChannel ch = new NotificationChannel(CHANNEL, "xVine server", NotificationManager.IMPORTANCE_LOW);
			ch.setDescription("Shown while xVine's offline library is running");
			nm.createNotificationChannel(ch);
		}
		Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
		PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
		Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
		Notification n = b.setContentTitle("xVine is running")
				.setContentText("Your offline library is available")
				.setSmallIcon(android.R.drawable.ic_menu_search)
				.setContentIntent(pi)
				.setOngoing(true)
				.build();
		if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
		else startForeground(1, n);
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		synchronized (NodeService.class) {
			if (!started) {
				started = true;
				new Thread(this::runNode, "xvine-node").start();
			}
		}
		return START_STICKY;
	}

	private void runNode() {
		try {
			File app = unpackServer();
			File data = dataDir(this);
			String[] args = {
				"node",
				new File(app, "server/boot.js").getAbsolutePath(),
				"--no-open",
				"--port", String.valueOf(PORT),
				"--data", data.getAbsolutePath(),
				"--log", new File(data, "server.log").getAbsolutePath(),
			};
			Log.i(TAG, "starting node: " + android.text.TextUtils.join(" ", args));
			int code = NodeBridge.start(args);
			Log.w(TAG, "node exited with " + code);
		} catch (Throwable t) {
			Log.e(TAG, "node failed", t);
		}
		// Node can't be restarted inside the same process: end it, and the
		// next launch starts fresh.
		stopForeground(true);
		stopSelf();
		android.os.Process.killProcess(android.os.Process.myPid());
	}

	/** Copy assets/xvine/** to app storage once per app version. */
	private File unpackServer() throws Exception {
		File dir = new File(getFilesDir(), "xvine-app");
		long version = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
		File stamp = new File(dir, ".version");
		if (stamp.exists() && readText(stamp).trim().equals(String.valueOf(version))) return dir;
		Log.i(TAG, "unpacking server to " + dir);
		deleteTree(dir);
		AssetManager am = getAssets();
		try (BufferedReader r = new BufferedReader(new InputStreamReader(am.open("xvine/files.txt"), "UTF-8"))) {
			String rel;
			while ((rel = r.readLine()) != null) {
				if (rel.isEmpty()) continue;
				File out = new File(dir, rel);
				out.getParentFile().mkdirs();
				try (InputStream in = am.open("xvine/" + rel); OutputStream os = new FileOutputStream(out)) {
					byte[] buf = new byte[65536];
					int n;
					while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
				}
			}
		}
		try (OutputStream os = new FileOutputStream(stamp)) {
			os.write(String.valueOf(version).getBytes("UTF-8"));
		}
		return dir;
	}

	private static String readText(File f) throws IOException {
		try (InputStream in = new java.io.FileInputStream(f)) {
			byte[] b = new byte[(int) f.length()];
			int off = 0, n;
			while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
			return new String(b, 0, off, "UTF-8");
		}
	}

	private static void deleteTree(File f) {
		File[] kids = f.listFiles();
		if (kids != null) for (File k : kids) deleteTree(k);
		f.delete();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}
}
