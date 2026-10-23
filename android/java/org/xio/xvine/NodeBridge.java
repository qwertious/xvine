package org.xio.xvine;

/** Loads nodejs-mobile and starts Node. Node can only run once per process. */
final class NodeBridge {
	static {
		System.loadLibrary("c++_shared");
		System.loadLibrary("node");
		System.loadLibrary("xvinenode");
	}

	private NodeBridge() {}

	/** Runs Node with these argv (argv[0] = "node"); blocks until it exits. */
	static native int start(String[] args);
}
