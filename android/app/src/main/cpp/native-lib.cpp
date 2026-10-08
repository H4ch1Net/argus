// Starts Node inside the app process (nodejs-mobile), after the
// nodejs-mobile-samples android/native-gradle sample: Node's stdout and stderr
// are piped to logcat (tag ARGUS-NODE), and node::Start runs on the calling
// thread until Node's event loop ends. Node can be started once per process.

#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

namespace {

const char *kTag = "ARGUS-NODE";

int pipe_stdout[2];
int pipe_stderr[2];

void *pump(void *arg) {
  const int fd = *static_cast<int *>(arg);
  const int priority = fd == pipe_stderr[0] ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    // logcat adds its own newline.
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(priority, kTag, buf);
  }
  return nullptr;
}

int redirect_stdio() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(pipe_stdout) == -1 || pipe(pipe_stderr) == -1) return -1;
  dup2(pipe_stdout[1], STDOUT_FILENO);
  dup2(pipe_stderr[1], STDERR_FILENO);
  pthread_t t_out;
  pthread_t t_err;
  if (pthread_create(&t_out, nullptr, pump, &pipe_stdout[0]) != 0) return -1;
  pthread_detach(t_out);
  if (pthread_create(&t_err, nullptr, pump, &pipe_stderr[0]) != 0) return -1;
  pthread_detach(t_err);
  return 0;
}

}  // namespace

// net.h4ch1.argus.NodeBridge.startNodeWithArguments(String[]): Int
extern "C" JNIEXPORT jint JNICALL
Java_net_h4ch1_argus_NodeBridge_startNodeWithArguments(JNIEnv *env, jobject /* this */,
                                                      jobjectArray arguments) {
  const jsize argc = env->GetArrayLength(arguments);
  std::vector<std::string> args;
  args.reserve(argc);
  for (jsize i = 0; i < argc; i++) {
    auto js = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char *chars = env->GetStringUTFChars(js, nullptr);
    args.emplace_back(chars ? chars : "");
    if (chars) env->ReleaseStringUTFChars(js, chars);
    env->DeleteLocalRef(js);
  }

  // libuv expects every argument in one contiguous block of memory.
  size_t total = 0;
  for (const auto &a : args) total += a.size() + 1;
  char *block = static_cast<char *>(calloc(total, 1));
  if (!block) return -1;
  std::vector<char *> argv(args.size() + 1, nullptr);
  char *cursor = block;
  for (size_t i = 0; i < args.size(); i++) {
    memcpy(cursor, args[i].c_str(), args[i].size() + 1);
    argv[i] = cursor;
    cursor += args[i].size() + 1;
  }

  if (redirect_stdio() == -1) {
    __android_log_write(ANDROID_LOG_ERROR, kTag, "could not redirect stdout/stderr to logcat");
  }

  // The block stays allocated: Node keeps pointers into argv for its lifetime.
  return jint(node::Start(static_cast<int>(args.size()), argv.data()));
}
