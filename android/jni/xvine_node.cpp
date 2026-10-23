// JNI bridge: starts Node (nodejs-mobile's libnode.so) on the calling thread
// and forwards its stdout/stderr to logcat under the tag "xvine-node".

#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

namespace node {
int Start(int argc, char* argv[]);
}

static int pipe_fds[2];

static void* log_thread(void*) {
	char buf[1024];
	ssize_t n;
	while ((n = read(pipe_fds[0], buf, sizeof buf - 1)) > 0) {
		if (buf[n - 1] == '\n') n--;
		buf[n] = 0;
		__android_log_write(ANDROID_LOG_INFO, "xvine-node", buf);
	}
	return nullptr;
}

static void redirect_output() {
	setvbuf(stdout, nullptr, _IONBF, 0);
	setvbuf(stderr, nullptr, _IONBF, 0);
	if (pipe(pipe_fds) != 0) return;
	dup2(pipe_fds[1], STDOUT_FILENO);
	dup2(pipe_fds[1], STDERR_FILENO);
	pthread_t t;
	if (pthread_create(&t, nullptr, log_thread, nullptr) == 0) pthread_detach(t);
}

extern "C" JNIEXPORT jint JNICALL Java_org_xio_xvine_NodeBridge_start(JNIEnv* env, jclass, jobjectArray args) {
	const jsize argc = env->GetArrayLength(args);

	// libuv rewrites the process title in place, so Node needs argv's
	// strings in one contiguous block.
	size_t total = 0;
	for (jsize i = 0; i < argc; i++) {
		jstring s = (jstring)env->GetObjectArrayElement(args, i);
		const char* c = env->GetStringUTFChars(s, nullptr);
		total += strlen(c) + 1;
		env->ReleaseStringUTFChars(s, c);
		env->DeleteLocalRef(s);
	}
	char* block = (char*)calloc(total, 1);
	char** argv = (char**)calloc(argc + 1, sizeof(char*));
	char* p = block;
	for (jsize i = 0; i < argc; i++) {
		jstring s = (jstring)env->GetObjectArrayElement(args, i);
		const char* c = env->GetStringUTFChars(s, nullptr);
		size_t len = strlen(c);
		memcpy(p, c, len);
		argv[i] = p;
		p += len + 1;
		env->ReleaseStringUTFChars(s, c);
		env->DeleteLocalRef(s);
	}

	redirect_output();
	return node::Start(argc, argv);
}
